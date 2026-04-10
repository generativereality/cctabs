import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { consola } from 'consola'
import { loadConfig } from './config.js'
import { requireWaveAdapter } from './wave.js'

interface OpenSessionOptions {
  tabName: string
  dir: string
  claudeCmd: string // e.g. "claude", "claude --continue", "claude --resume <id> --fork-session"
  workspaceQuery?: string
  /** If set, poll for Claude's ready prompt then send this file's content as the initial task */
  initialPromptFile?: string
}

/** Poll scrollback until a pattern is visible, then return. Rejects on timeout. */
async function waitForScrollbackMatch(
  adapter: ReturnType<typeof requireWaveAdapter>,
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

export async function openSession(opts: OpenSessionOptions): Promise<string> {
  const { tabName, claudeCmd, workspaceQuery, initialPromptFile } = opts
  const dir = resolve(opts.dir.replace(/^~/, homedir()))

  if (!existsSync(dir)) {
    consola.error(`Directory does not exist: ${dir}`)
    process.exit(1)
  }

  const config = loadConfig()

  const adapter = requireWaveAdapter()

  let focusWindowId: string | undefined

  if (workspaceQuery) {
    const { workspaces } = await adapter.getAllData()
    const matches = adapter.resolveWorkspace(workspaces, workspaceQuery)
    if (!matches.length) {
      consola.error(`No workspace matching '${workspaceQuery}'`)
      process.exit(1)
    }
    const { data, windowId } = matches[0]
    if (!windowId) {
      consola.error(`Workspace '${data.name}' has no open window`)
      process.exit(1)
    }
    focusWindowId = windowId
    consola.info(`Workspace: ${data.name}`)
  }

  const beforeIds = new Set(
    adapter.blocksList().filter((b) => b.view === 'term').map((b) => b.blockid),
  )

  await adapter.newTab(focusWindowId)

  const result = await adapter.waitForNewBlock(beforeIds)
  if (!result) {
    consola.error('Timed out waiting for new terminal block')
    process.exit(1)
  }

  const { blockId, tabId } = result
  await adapter.renameTab(tabId, tabName)

  // Wait for the shell prompt before sending the cd && claude command.
  // Without this, the input can arrive before the shell is ready and get lost.
  // Match common prompt endings: bash ($), zsh (%), fish/other (>)
  try {
    await waitForScrollbackMatch(adapter, blockId, /[$%>]\s*$/, 'shell prompt', 10_000, 250)
  } catch {
    consola.error('Shell prompt never appeared in new tab — aborting. Check your shell profile (e.g. nvm default alias).')
    process.exit(1)
  }

  const extraFlags = config.claude.flags.join(' ')
  const namePart = claudeCmd.includes('--resume') ? '' : ` --name ${JSON.stringify(tabName)}`
  const cmd = `cd ${JSON.stringify(dir)} && claude${extraFlags ? ' ' + extraFlags : ''} ${claudeCmd.replace(/^claude\s*/, '')}${namePart}\r`
  await adapter.sendInput(blockId, cmd)

  if (initialPromptFile) {
    // Poll until Claude's ready prompt appears, then send the initial task
    try {
      await waitForScrollbackMatch(adapter, blockId, '❯', 'Claude prompt', 30_000)
    } catch {
      consola.error('Claude prompt (❯) never appeared — not sending initial prompt. Check that claude started successfully.')
      adapter.closeSocket()
      process.exit(1)
    }
    const prompt = readFileSync(initialPromptFile, 'utf-8').trimEnd()
    await adapter.sendInput(blockId, prompt)
    // Send Enter separately — bracketed paste mode swallows \r inside the paste
    await new Promise((r) => setTimeout(r, 100))
    await adapter.sendInput(blockId, '\r')
  }

  // Wait for Wave to fully process the new tab before returning, so rapid
  // back-to-back `herd new` calls don't race on waitForNewBlock.
  await new Promise((r) => setTimeout(r, 2000))

  adapter.closeSocket()

  return tabId
}
