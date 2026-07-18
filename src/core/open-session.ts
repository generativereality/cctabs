import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { consola } from 'consola'
import { loadConfig } from './config.js'
import { requireAdapter, type TerminalAdapter } from './adapter.js'
import { shellQuoteArg } from './shell.js'

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
   * Insert the new tab right after the currently-active tab instead of at the
   * end of the bar (Tabby openTabDirect path only). Used by single-tab opens
   * (`new`/`fork`/`resume`) for browser-style "open next to me"; restore leaves
   * it off and reorders the whole bar afterwards.
   */
  afterActive?: boolean
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for Claude's input prompt, then send the initial task and reliably
 * submit it.
 *
 * The naive "send text, then send \r" is unreliable for two distinct reasons,
 * each handled by its own verify-and-retry stage:
 *
 *   1. The paste can be *dropped*. The welcome-screen placeholder (`❯ Try "…"`)
 *      renders several seconds before the input handler is fully attached, so
 *      input sent the instant `❯` appears lands in a not-ready terminal and is
 *      silently lost — the box stays empty and a later Enter does nothing.
 *      Fix: after pasting, confirm the text actually landed in the box and
 *      re-paste if not (clearing first so a retry never duplicates).
 *
 *   2. The Enter can be *swallowed*. A burst of "text then \r" is seen as one
 *      bracketed paste and the \r is absorbed as a newline rather than a
 *      submit. Fix: wrap the prompt in explicit bracketed-paste markers so the
 *      Enter lands outside the paste, then confirm a turn actually started
 *      (spinner / "esc to interrupt" appear only while Claude is processing)
 *      and re-send Enter a few times if not.
 *
 * Landed-detection handles both render shapes observed empirically: a short
 * prompt is echoed inline (so a distinctive prompt substring appears), while a
 * long / multi-line prompt collapses to a "[Pasted text #N +M lines]" chip.
 */
async function sendInitialPrompt(
  adapter: TerminalAdapter,
  blockId: string,
  initialPromptFile: string,
): Promise<void> {
  // The first ready signal only means the UI has rendered — treat it as a
  // starting gun and verify the paste below rather than trusting the input is
  // ready. Accept any of Claude's ready shapes: the prompt glyph, the welcome
  // placeholder, or the input footer. Be patient: under heavy load (e.g. right
  // after a large `restore`) Tabby's buffer-read for a brand-new tab can lag
  // well past the old 30s window even though the tab is perfectly fine.
  const readySignal = /❯|auto mode|for agents|Try ["'“]/
  try {
    await waitForScrollbackMatch(adapter, blockId, readySignal, 'Claude prompt', 45_000)
  } catch {
    // Do NOT abort. The tab IS created and usable, and the readiness signal can
    // simply be slow to surface rather than absent. Attempt the paste anyway —
    // stage 1 below confirms the text actually landed (re-pasting if dropped)
    // and degrades to a warning if it truly never does. Throwing here would
    // fail the whole `cctabs new` (exit 1) and force the user to send the
    // prompt by hand even though the session started fine.
    consola.warn('Could not confirm Claude was ready within 45s — sending the prompt anyway (will verify it lands).')
  }

  // Auto-confirm Claude's "Do you trust the files in this folder?" dialog when
  // the session opens on it (a new/untrusted cwd, e.g. a freshly created repo).
  // Its menu reuses the ❯ glyph, so the wait above matches the dialog rather
  // than the chat input, and a paste here would be lost into the menu. Enter
  // selects the default "Yes, I trust this folder". cctabs only ever launches
  // Claude in a directory the caller explicitly named, so trusting it is the
  // intended action.
  //
  // Retry, patiently: the dialog has its own not-ready window right as it
  // renders (its input handler attaches a beat after the text paints), so an
  // Enter sent the instant it appears is dropped. Once it *did* appear, keep
  // pressing Enter until a FORWARD signal proves we're past it — the chat
  // input's footer ("auto mode" / "for agents") or placeholder ("Try …"),
  // none of which the dialog shows. (The output log is append-only, so we
  // can't detect dismissal by the dialog text *disappearing* — only by new
  // post-dialog content appearing.)
  const sawTrust = /trustthisfolder|Yes,?Itrustthis|Isthisaproject/i.test(
    adapter.scrollback(blockId, 40).replace(/\s+/g, ''),
  )
  if (sawTrust) {
    for (let attempt = 0; attempt < 18; attempt++) {
      const screen = adapter.scrollback(blockId, 14).replace(/\s+/g, '')
      if (/automode|foragents|Try["'“]/i.test(screen)) break
      await adapter.sendInput(blockId, '\r')
      await sleep(800)
    }
  }

  const prompt = readFileSync(initialPromptFile, 'utf-8').trimEnd()
  // Distinctive chunk for the inline-echo case. Claude's output is append-only
  // so once this (or the paste chip) shows up it stays — fine within this one
  // call on a fresh tab.
  const sentinel = prompt.replace(/\s+/g, '').slice(0, 24)
  const landed = (): boolean => {
    const c = adapter.scrollback(blockId, 60).replace(/\s+/g, '')
    return (sentinel.length >= 4 && c.includes(sentinel)) || c.includes('[Pastedtext')
  }

  // Stage 1: paste, confirm it landed, re-paste if dropped.
  let inBox = false
  for (let attempt = 0; attempt < 3 && !inBox; attempt++) {
    // Clear first on retries so a re-paste never stacks a second copy.
    if (attempt > 0) { await adapter.sendInput(blockId, '\x15'); await sleep(200) }
    await adapter.sendInput(blockId, `\x1b[200~${prompt}\x1b[201~`)
    for (let i = 0; i < 8; i++) {
      await sleep(300)
      if (landed()) { inBox = true; break }
    }
  }
  if (!inBox) {
    consola.warn('Initial prompt may not have landed in the input box — switch to the tab and press Enter (re-type if the box is empty).')
    return
  }

  // Stage 2: submit, confirm the turn started, re-send Enter if not. The input
  // handler can still be settling right as the prompt lands, so the first
  // Enter(s) get dropped — keep nudging for a few seconds. Re-pressing Enter is
  // safe: once the turn starts we return immediately, and an extra Enter on an
  // empty input box is a no-op in Claude.
  for (let attempt = 0; attempt < 8; attempt++) {
    await adapter.sendInput(blockId, '\r')
    await sleep(700)
    const tail = adapter.scrollback(blockId, 40)
    // Tabby's buffer can drop spaces between glyphs, so also check a
    // whitespace-stripped copy for the text hint.
    if (/[✻✽✶✳✢]/.test(tail) || /esctointerrupt/i.test(tail.replace(/\s+/g, ''))) return
  }

  consola.warn('Could not confirm the initial prompt was submitted — switch to the tab and press Enter to send it.')
}

/**
 * Auto-advance Claude's "resume" picker that appears when `claude --resume <id>`
 * reattaches a large/old session:
 *
 *   ❯ 1. Resume from summary (recommended)
 *     2. Resume full session as-is
 *     3. Don't ask me again
 *
 * It blocks the tab until you choose, which is why a plain `restore` leaves
 * such tabs stuck. cctabs always wants the FULL session — the whole point of
 * restore is to bring the conversation back intact, not a lossy summary — so we
 * select option 2.
 *
 * Like the trust dialog, the picker has a brief not-ready window as it paints,
 * so we poll for it to appear, settle, then navigate. The default highlight is
 * option 1, so we move the cursor DOWN exactly once to reach option 2. We send
 * ↓ only once on purpose: spamming it across retries could land on option 3
 * ("Don't ask me again"), which permanently changes the user's config. The
 * confirm is the part we retry — re-pressing Enter on the same row is safe, and
 * if the single ↓ was ever dropped the worst case is a (still-usable) summary
 * resume, never option 3.
 *
 * Two robustness properties, both learned from a real 47-session restore where
 * one tab hung on the picker and another landed on a stray info overlay:
 *
 *   - Adaptive appear-poll. Under heavy load (right after a large `restore`)
 *     the picker can be slow to paint, so we stay patient the same way
 *     sendInitialPrompt waits up to 45s for Claude's prompt. But we early-exit
 *     the wait the instant a FORWARD signal proves the session already loaded
 *     WITHOUT a picker — the input footer ("auto mode" / "for agents" / the
 *     `Try "…"` placeholder) or the mobile-app overlay below. That keeps the
 *     common no-picker resume fast instead of always burning the full window.
 *
 *   - Mobile-app overlay sweep. After the session loads, Claude can paint a
 *     remote-control info overlay ("Continue coding in the Claude mobile app …
 *     Enter/Esc to close") that steals the keypress focus and leaves the tab on
 *     an overlay rather than a clean prompt. We detect it (whitespace-stripped,
 *     because Tabby's buffer drops spaces between glyphs) and Esc it closed.
 *     Idempotent: when the overlay never appears the poll simply expires as a
 *     no-op. It can appear on a direct resume too, so the sweep runs even when
 *     no picker was seen.
 */
export async function confirmResumePicker(
  adapter: TerminalAdapter,
  blockId: string,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const nap = deps.sleep ?? sleep
  const stripped = (n: number) => adapter.scrollback(blockId, n).replace(/\s+/g, '')
  const pickerVisible = (n: number) => {
    const c = stripped(n)
    return /Resumefromsummary/i.test(c) && /Resumefullsession/i.test(c)
  }
  const rcOverlayVisible = (n: number) => {
    const c = stripped(n)
    return /Continuecoding.*mobileapp/i.test(c) || /Enter\/Esctoclose/i.test(c)
  }
  // A forward signal that the session has finished loading (so no picker will
  // come). Deliberately the input footer / placeholder rather than a bare ❯:
  // the picker and trust menu also draw ❯, whereas these strings appear only on
  // the live chat input. The RC overlay counts too — it only shows post-load.
  const sessionLoaded = (n: number) =>
    /automode|foragents|Try["'“]/i.test(stripped(n)) || rcOverlayVisible(n)

  // The picker renders before the session loads. Stay patient (~45s) for it to
  // appear under heavy load, but bail early once the session is demonstrably
  // loaded without one — nothing to confirm on the picker in that case.
  let appeared = false
  for (let i = 0; i < 45; i++) {
    if (pickerVisible(30)) { appeared = true; break }
    if (sessionLoaded(30)) break
    await nap(1000)
  }

  if (appeared) {
    // Let the picker's key handler attach before the one navigation press.
    await nap(1200)
    await adapter.sendInput(blockId, '\x1b[B') // ↓ once → option 2 (full session)
    await nap(250)

    // Confirm, retrying Enter only, until the picker scrolls out of the tail
    // (the loaded session pushes new content past it). More attempts than the
    // original 8 so a slow load under heavy restore load still clears.
    let dismissed = false
    for (let attempt = 0; attempt < 15; attempt++) {
      await adapter.sendInput(blockId, '\r')
      await nap(900)
      if (!pickerVisible(8)) { dismissed = true; break }
    }
    if (!dismissed) {
      consola.warn('Could not confirm the resume picker was dismissed — switch to the tab and pick "Resume full session as-is".')
      return
    }
  }

  // Sweep for the mobile-app info overlay and Esc it closed. Runs whether we
  // came through the picker or resumed directly; a no-op when absent.
  let sawOverlay = false
  for (let i = 0; i < 8; i++) {
    if (rcOverlayVisible(20)) { sawOverlay = true; break }
    await nap(400)
  }
  if (!sawOverlay) return

  for (let attempt = 0; attempt < 6; attempt++) {
    await adapter.sendInput(blockId, '\x1b') // Esc closes the overlay
    await nap(500)
    if (!rcOverlayVisible(20)) return
  }
  consola.warn('Could not confirm the mobile-app info overlay was dismissed — switch to the tab and press Esc.')
}

export async function openSession(opts: OpenSessionOptions): Promise<string> {
  const { tabName, claudeCmd, workspaceQuery, initialPromptFile, envVars, modelOverride, afterActive } = opts
  const tailDelayMs = opts.tailDelayMs ?? 2000
  // Resuming an existing session can pop the "Resume from summary / full
  // session" picker, which blocks the tab until answered — auto-advance it.
  const isResume = /--resume\b/.test(claudeCmd)
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
  // rename → wait-for-shell-prompt dance entirely. We run claude inside a login
  // *interactive* shell so the user's profile (PATH, nvm, pyenv, …) is sourced
  // — claude and its npx-based MCP servers need it. When claude exits we hand
  // control to a fresh interactive login shell (`; exec $SHELL -l -i`) rather
  // than `exec`-ing claude as the tab's pid: an exec'd claude leaves the tab
  // dead at "[process completed]" — a hung tab with no prompt — the moment you
  // quit claude or Ctrl-C out of it. `;` (not `&&`) so the shell appears even
  // when claude exits non-zero or via signal, and the launch shell's own `-i`
  // keeps it alive through the SIGINT that interrupts claude.
  // (workspaceQuery is a Wave-only window concept and does not apply here.)
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
    const extraFlags = config.claude.flags.map(shellQuoteArg).join(' ')
    // `tabName` is used verbatim for both the tab title and `--name`. Any
    // configured `defaults.prefix` is already baked in by the minting command
    // (`new`/`resume`/`fork`); `restore`/`import` pass the session's existing
    // recorded name and must NOT be re-prefixed, so the prefix lives there, not
    // here.
    const namePart = claudeCmd.includes('--resume') ? '' : ` --name ${JSON.stringify(tabName)}`
    const modelPart = modelOverride ? ` --model ${JSON.stringify(modelOverride)}` : ''
    const envPrefix = envVars ? shellQuoteEnv(envVars) : ''
    const claudeCore = `claude${extraFlags ? ' ' + extraFlags : ''} ${claudeCmd.replace(/^claude\s*/, '')}${namePart}${modelPart}`.replace(/\s+/g, ' ').trim()
    const shell = process.env.SHELL ?? '/bin/zsh'
    const launch = `${envPrefix}${claudeCore}; exec ${shell} -l -i`

    const { blockId, tabId } = await adapter.openTabDirect({
      cwd: dir,
      title: tabName,
      command: shell,
      args: ['-l', '-i', '-c', launch],
      afterActive,
    })
    mark('openTabDirect')

    if (isResume) {
      await confirmResumePicker(adapter, blockId)
      mark('resumePicker')
    }

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

  const extraFlags = config.claude.flags.map(shellQuoteArg).join(' ')
  const namePart = claudeCmd.includes('--resume') ? '' : ` --name ${JSON.stringify(tabName)}`
  const modelPart = modelOverride ? ` --model ${JSON.stringify(modelOverride)}` : ''
  const envPrefix = envVars ? shellQuoteEnv(envVars) : ''
  const cmd = `cd ${JSON.stringify(dir)} && ${envPrefix}claude${extraFlags ? ' ' + extraFlags : ''} ${claudeCmd.replace(/^claude\s*/, '')}${namePart}${modelPart}\r`
  await adapter.sendInput(blockId, cmd)

  if (isResume) {
    await confirmResumePicker(adapter, blockId)
    mark('resumePicker')
  }

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
