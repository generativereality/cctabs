import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { consola } from 'consola'
import { loadConfig } from './config.js'
import { requireAdapter, type TerminalAdapter } from './adapter.js'

interface OpenSessionOptions {
  tabName: string
  dir: string
  claudeCmd: string // e.g. "claude", "claude --continue", "claude --resume <id> --fork-session"
  workspaceQuery?: string
  /** If set, poll for Claude's ready prompt then send this file's content as the initial task */
  initialPromptFile?: string
  /** Env vars to prepend to the shell command (e.g. ANTHROPIC_BASE_URL for Ollama) */
  envVars?: Record<string, string>
  /** If set, append `--model <name>` to the claude command */
  modelOverride?: string
  /**
   * Settle delay after the tab is created and the command sent, before
   * returning. Guards rapid back-to-back calls from racing on waitForNewBlock.
   * Defaults to 2000ms. Batch callers (e.g. restore) can lower this: by the
   * time we return, waitForNewBlock has already confirmed the new block is
   * visible in `blocks list`, so the next call's beforeIds snapshot is complete
   * regardless — a short settle is enough to let Wave's tab animation finish.
   */
  tailDelayMs?: number
}

function shellQuoteEnv(env: Record<string, string>): string {
  const entries = Object.entries(env)
  if (!entries.length) return ''
  return (
    entries
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(' ') + ' '
  )
}

/** Poll scrollback until a pattern is visible, then return. Rejects on timeout. */
async function waitForScrollbackMatch(
  adapter: TerminalAdapter,
  blockId: string,
  pattern: string | RegExp,
  label: string,
  timeoutMs: number,
  pollInterval = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval))
    try {
      const lines = adapter.scrollback(blockId, 10)
      if (!lines) continue
      const match = typeof pattern === 'string'
        ? lines.includes(pattern)
        : pattern.test(lines)
      if (match) return
    } catch {
      // scrollback not yet available — keep polling
    }
  }
  throw new Error(`Timed out waiting for ${label}`)
}

/**
 * Wait for Claude's input prompt, then send the initial task and reliably
 * submit it.
 *
 * Reliability matters because a naive "send text, then send \r" loses the
 * Enter for multi-line prompts: the terminal treats the burst as a bracketed
 * paste and swallows a \r that arrives inside the paste window, leaving the
 * text sitting unsent in the input box. We fix that two ways:
 *   1. Wrap the prompt in explicit bracketed-paste markers so the (possibly
 *      multi-line) text is ingested as one paste and the following Enter lands
 *      *outside* it — an unambiguous submit, not a newline.
 *   2. Verify the turn actually started (a spinner / "esc to interrupt" hint
 *      appears only while Claude is processing, never at the idle prompt), and
 *      re-send Enter a few times if not, since a large paste can still be
 *      mid-ingest when the first Enter arrives.
 */
async function sendInitialPrompt(
  adapter: TerminalAdapter,
  blockId: string,
  initialPromptFile: string,
): Promise<void> {
  try {
    await waitForScrollbackMatch(adapter, blockId, '❯', 'Claude prompt', 30_000)
  } catch {
    adapter.closeSocket()
    throw new Error('Claude prompt (❯) never appeared — not sending initial prompt. Check that claude started successfully.')
  }

  const prompt = readFileSync(initialPromptFile, 'utf-8').trimEnd()
  // Bracketed-paste wrap; prompt is already trimEnd()'d so no stray newline
  // ends up inside the markers.
  await adapter.sendInput(blockId, `\x1b[200~${prompt}\x1b[201~`)

  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, attempt === 0 ? 300 : 500))
    await adapter.sendInput(blockId, '\r')
    await new Promise((r) => setTimeout(r, 500))
    const tail = adapter.scrollback(blockId, 40)
    // Tabby's buffer can drop spaces between glyphs, so match a
    // whitespace-stripped copy for the text hint.
    const compact = tail.replace(/\s+/g, '')
    if (/[✻✽✶✳✢]/.test(tail) || /esctointerrupt/i.test(compact)) return
  }

  consola.warn('Could not confirm the initial prompt was submitted — it may be sitting in the input box. Press Enter in the tab to send it.')
}

export async function openSession(opts: OpenSessionOptions): Promise<string> {
  const { tabName, claudeCmd, workspaceQuery, initialPromptFile, envVars, modelOverride } = opts
  const tailDelayMs = opts.tailDelayMs ?? 2000
  const dir = resolve(opts.dir.replace(/^~/, homedir()))

  if (!existsSync(dir)) {
    throw new Error(`Directory does not exist: ${dir}`)
  }

  const config = loadConfig()

  const adapter = requireAdapter()

  // Optional per-phase timing diagnostics (CCTABS_TIMING=1). Helps profile
  // where the per-tab cost goes during a large `restore`.
  const timing = !!process.env.CCTABS_TIMING
  let tPhase = Date.now()
  const mark = (label: string) => {
    if (!timing) return
    const now = Date.now()
    consola.log(`    ⏱ ${tabName} ${label}: ${now - tPhase}ms`)
    tPhase = now
  }

  // Fast path: adapters that can launch a command in a fresh tab and return
  // its id directly (Tabby's plugin) skip the newTab → waitForNewBlock →
  // rename → wait-for-shell-prompt dance entirely, and can be driven in
  // parallel by the caller. We run claude *as the tab's process* via a login
  // *interactive* shell so the user's profile (PATH, nvm, pyenv, …) is sourced
  // — claude and its npx-based MCP servers need it — and `exec` replaces the
  // shell so the tab process *is* claude. (workspaceQuery is a Wave-only
  // window concept and does not apply here.)
  //
  // Why both -l and -i: `-l -c` alone is a non-interactive login shell, which
  // sources `~/.zprofile` (path_helper → /opt/homebrew/bin etc.) but NOT
  // `~/.zshrc`. Users who add tooling to PATH from `.zshrc` (the macOS
  // convention for things like ~/.local/bin, pnpm/npm-global, mise/asdf
  // shims) end up with "command not found: claude" in the spawned tab.
  // Adding `-i` makes zsh source `.zshrc` even with `-c`, matching what an
  // interactive Terminal/Tabby tab would see. Same logic applies to bash
  // (`-l -i -c` sources both ~/.profile and ~/.bashrc on Linux).
  if (adapter.openTabDirect) {
    const extraFlags = config.claude.flags.join(' ')
    const namePart = claudeCmd.includes('--resume') ? '' : ` --name ${JSON.stringify(tabName)}`
    const modelPart = modelOverride ? ` --model ${JSON.stringify(modelOverride)}` : ''
    const envPrefix = envVars ? shellQuoteEnv(envVars) : ''
    const claudeCore = `claude${extraFlags ? ' ' + extraFlags : ''} ${claudeCmd.replace(/^claude\s*/, '')}${namePart}${modelPart}`.replace(/\s+/g, ' ').trim()
    const shell = process.env.SHELL ?? '/bin/zsh'
    const launch = `${envPrefix}exec ${claudeCore}`

    const { blockId, tabId } = await adapter.openTabDirect({
      cwd: dir,
      title: tabName,
      command: shell,
      args: ['-l', '-i', '-c', launch],
    })
    mark('openTabDirect')

    if (initialPromptFile) {
      await sendInitialPrompt(adapter, blockId, initialPromptFile)
    }

    adapter.closeSocket()
    return tabId
  }

  let focusWindowId: string | undefined

  if (workspaceQuery) {
    const { workspaces } = await adapter.getAllData()
    const matches = adapter.resolveWorkspace(workspaces, workspaceQuery)
    if (!matches.length) {
      throw new Error(`No workspace matching '${workspaceQuery}'`)
    }
    const { data, windowId } = matches[0]
    if (!windowId) {
      throw new Error(`Workspace '${data.name}' has no open window`)
    }
    focusWindowId = windowId
    consola.info(`Workspace: ${data.name}`)
  }

  const beforeIds = new Set(
    adapter.blocksList().filter((b) => b.view === 'term').map((b) => b.blockid),
  )
  mark('beforeIds')

  await adapter.newTab(focusWindowId)
  mark('newTab')

  const result = await adapter.waitForNewBlock(beforeIds)
  if (!result) {
    throw new Error('Timed out waiting for new terminal block')
  }
  mark('waitForNewBlock')

  const { blockId, tabId } = result
  await adapter.renameTab(tabId, tabName)
  mark('renameTab')

  // Wait for the shell prompt before sending the cd && claude command.
  // Without this, the input can arrive before the shell is ready and get lost.
  // Match common prompt endings: bash ($), zsh (%), fish/other (>)
  try {
    await waitForScrollbackMatch(adapter, blockId, /[$%>]\s*$/, 'shell prompt', 10_000, 250)
  } catch {
    throw new Error('Shell prompt never appeared in new tab — aborting. Check your shell profile (e.g. nvm default alias).')
  }
  mark('shellPrompt')

  const extraFlags = config.claude.flags.join(' ')
  const namePart = claudeCmd.includes('--resume') ? '' : ` --name ${JSON.stringify(tabName)}`
  const modelPart = modelOverride ? ` --model ${JSON.stringify(modelOverride)}` : ''
  const envPrefix = envVars ? shellQuoteEnv(envVars) : ''
  const cmd = `cd ${JSON.stringify(dir)} && ${envPrefix}claude${extraFlags ? ' ' + extraFlags : ''} ${claudeCmd.replace(/^claude\s*/, '')}${namePart}${modelPart}\r`
  await adapter.sendInput(blockId, cmd)

  if (initialPromptFile) {
    await sendInitialPrompt(adapter, blockId, initialPromptFile)
  }

  // Wait for Wave to fully process the new tab before returning, so rapid
  // back-to-back `cctabs new` calls don't race on waitForNewBlock.
  if (tailDelayMs > 0) await new Promise((r) => setTimeout(r, tailDelayMs))
  mark('tail')

  adapter.closeSocket()

  return tabId
}
