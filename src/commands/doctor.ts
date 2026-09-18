import { spawnSync } from 'child_process'
import { define } from 'gunshi'
import { detectTerminal, resolveTerminal, type KnownTerminal } from '../core/terminal.js'
import { manualInstallSnippet } from '../core/tabby-plugin-dir.js'
import { resolveTabShell, findGitBash } from '../core/shell.js'
import { win32 as pathWin32 } from 'path'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

interface CheckResult {
  name: string
  status: CheckStatus
  detail?: string
  hint?: string
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: '✔',
  warn: '⚠',
  fail: '✘',
  skip: '–',
}

function printResult (r: CheckResult): void {
  const glyph = STATUS_GLYPH[r.status]
  const line = `  ${glyph}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`
  console.log(line)
  if (r.hint) console.log(`       ↳ ${r.hint}`)
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkTerminal (terminal: KnownTerminal, note?: string): CheckResult {
  if (terminal === 'tabby') {
    return { name: 'Terminal', status: 'ok', detail: note ? `${terminal} (${note})` : terminal }
  }
  if (terminal === 'wave') {
    return {
      name: 'Terminal',
      status: 'fail',
      detail: 'wave — support withdrawn in 0.5.0',
      hint: 'Switch to Tabby: `brew install --cask tabby`, then run ' +
        '`cctabs install-tabby-plugin` from inside a Tabby tab. Your Claude sessions ' +
        'are unaffected — `cctabs restore` reopens them by name.',
    }
  }
  return {
    name: 'Terminal',
    status: 'fail',
    detail: terminal === 'unknown' ? 'unrecognised' : terminal,
    hint: 'cctabs supports Tabby. Switch to it, or ' +
      'set CCTABS_TERMINAL=tabby (e.g. over SSH) if the Tabby plugin is running on this host.',
  }
}

interface TabbyHealth { ok: boolean; version?: string; raw?: string; error?: string }

function probeTabbyPlugin (host: string, port: number): TabbyHealth {
  const r = spawnSync(
    'curl',
    ['-fsS', '--max-time', '3', `http://${host}:${port}/api/health`],
    { encoding: 'utf-8' },
  )
  if (r.status !== 0 || !r.stdout) {
    return { ok: false, error: (r.stderr || '').trim() || `exit ${r.status}` }
  }
  try {
    const parsed = JSON.parse(r.stdout) as { ok: boolean; version?: string }
    return { ok: !!parsed.ok, version: parsed.version, raw: r.stdout }
  } catch {
    return { ok: false, error: 'non-JSON response', raw: r.stdout }
  }
}

function checkTabbyPlugin (): CheckResult {
  const host = process.env.CCTABS_TABBY_HOST ?? '127.0.0.1'
  const port = Number(process.env.CCTABS_TABBY_PORT ?? '3300')
  const health = probeTabbyPlugin(host, port)
  if (health.ok) {
    return {
      name: 'Tabby cctabs plugin',
      status: 'ok',
      detail: `${host}:${port}, version ${health.version ?? 'unknown'}`,
    }
  }
  return {
    name: 'Tabby cctabs plugin',
    status: 'fail',
    detail: `${host}:${port} unreachable (${health.error ?? 'unknown'})`,
    hint:
      'Run `cctabs install-tabby-plugin` from inside a Tabby tab — it npm-installs the plugin and reopens Tabby. ' +
      `Or do it by hand: \`${manualInstallSnippet()}\`, then quit + reopen Tabby.`,
  }
}

/**
 * Probe whether `node` is findable in a freshly spawned shell — the canonical
 * symptom of the macOS PATH-sourcing bug. Spawning `zsh -l -i -c 'command -v
 * node'` simulates the same login + interactive shell init (/etc/zprofile →
 * path_helper, then ~/.zshrc) that cctabs uses when it opens new Tabby tabs.
 * If this fails, brand-new tabs will also fail to find Node, every plugin MCP
 * that shells out to npx will ENOENT, and the cctabs CLI itself becomes
 * unusable from inside those tabs (chicken-and-egg). The flags must match
 * open-session.ts to keep the doctor honest.
 */
function checkSpawnedShellPath (): CheckResult {
  // Probe the shell a tab would ACTUALLY get. Hardcoding zsh made this check
  // dishonest on Windows twice over: it reported `spawnSync zsh ENOENT` on a
  // machine with a perfectly good Git Bash, and it said nothing about the
  // shell the spawn was really going to use.
  const shell = resolveTabShell()
  const args = shell.posix
    ? ['-l', '-i', '-c', 'command -v node']
    : ['/c', 'where node']
  const r = spawnSync(shell.command, args, { encoding: 'utf-8', timeout: 5000 })
  if (r.status === 0 && r.stdout?.trim()) {
    return {
      name: 'Spawned shell PATH (node findable)',
      status: 'ok',
      detail: `${shell.command} → ${r.stdout.trim().split(/\r?\n/)[0]}`,
    }
  }
  return {
    name: 'Spawned shell PATH',
    status: 'warn',
    detail: `${shell.command}: ${r.error?.message ?? r.stderr?.trim() ?? 'node not found'}`,
    hint: shell.posix
      ? 'A login+interactive shell cannot find `node`. Either node is not installed, or PATH is broken. ' +
        'cctabs spawns tabs with `<shell> -l -i -c`, so on macOS both ~/.zprofile and ~/.zshrc are sourced — ' +
        'if your PATH-extending logic lives elsewhere (e.g. a sourced file that bails on non-interactive), ' +
        'move the `export PATH=...` lines into ~/.zshenv as a belt-and-braces fix.'
      : 'No POSIX shell was found, so tabs will be spawned with cmd.exe. Install Git for Windows to get ' +
        'Git Bash (cctabs derives it from whatever `git` is on PATH), or set CCTABS_SHELL to the shell you want.',
  }
}

/** First hit for `cmd` on the CLI's own PATH, or undefined. */
function whichOnPath (cmd: string): string | undefined {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const r = spawnSync(finder, [cmd], { encoding: 'utf-8', timeout: 5000 })
  if (r.status !== 0) return undefined
  return (r.stdout ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0]
}

/**
 * Windows only, and deliberately not about cctabs.
 *
 * cctabs does not need `bash` on PATH — resolveTabShell() derives Git Bash from
 * `git`. **Claude Code does**, and when it is missing Claude Code silently
 * substitutes a PowerShell tool for its Bash tool. Nothing errors; a Bash
 * permission allowlist just quietly stops covering what the agent reaches for,
 * and the person does not find out until something they thought was allowed is
 * refused, or something they thought was blocked is not.
 *
 * This lives here because the doctor is the only thing that already knows where
 * Git Bash is, so it can print the exact directory to add instead of telling
 * someone to go and find it.
 */
export const AGENT_BASH_CHECK = 'bash on PATH (Claude Code\'s Bash tool)'

/**
 * Pure half of the check, so the message can be tested without a Windows machine
 * (which is the only place it runs, and the one place this repo's CI is not).
 */
export function agentBashResult (onPath: string | undefined, gitBash: string | undefined): CheckResult {
  const name = AGENT_BASH_CHECK
  if (onPath) return { name, status: 'ok', detail: onPath }

  const consequence =
    'Claude Code substitutes a PowerShell tool for its Bash tool, so a Bash allowlist stops ' +
    'covering what the agent runs.'

  if (!gitBash) {
    return {
      name,
      status: 'warn',
      detail: 'no bash found anywhere',
      hint: `Install Git for Windows. Without a bash on PATH, ${consequence}`,
    }
  }
  return {
    name,
    status: 'warn',
    detail: `${gitBash} exists, but is not on PATH`,
    // win32.dirname, not dirname: this only ever runs on Windows, and the POSIX
    // dirname returns '.' for a backslash path — which is how the test caught it.
    hint: `${consequence} Add it: \`setx PATH "%PATH%;${pathWin32.dirname(gitBash)}"\` (new terminals ` +
      'only). cctabs itself is unaffected — it derives this path from `git`.',
  }
}

function checkAgentBashOnPath (): CheckResult {
  return agentBashResult(whichOnPath('bash'), findGitBash())
}

/**
 * Whether the tab's shell can find `claude`. cctabs launches `claude` inside the
 * spawned shell, so this is the difference between a tab that starts a session
 * and a tab that opens on an error — and on Windows the installer does not add
 * itself to PATH, so `claude` being absent is the expected state rather than a
 * failed install. Probed in the shell a tab actually gets, not this process's
 * PATH, because those differ on Windows.
 */
function checkClaudeInSpawnedShell (): CheckResult {
  const name = 'claude in the spawned shell'
  const shell = resolveTabShell()
  const args = shell.posix ? ['-l', '-i', '-c', 'command -v claude'] : ['/c', 'where claude']
  const r = spawnSync(shell.command, args, { encoding: 'utf-8', timeout: 8000 })
  if (r.status === 0 && r.stdout?.trim()) {
    return { name, status: 'ok', detail: r.stdout.trim().split(/\r?\n/)[0] }
  }
  const windows = process.platform === 'win32'
  return {
    name,
    status: 'warn',
    detail: `${shell.command}: claude not found`,
    hint: windows
      ? 'On Windows the Claude Code installer does not put itself on PATH — the binary is ' +
        'usually there. Find it and add its directory, or set `claude.command` in cctabs config ' +
        'to the full path. New tabs will open on a "command not found" until this resolves.'
      : 'New tabs will open on a "command not found". Install Claude Code, or set ' +
        '`claude.command` in cctabs config to its full path.',
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const doctorCommand = define({
  name: 'doctor',
  description: 'Run environment checks (terminal detection, Tabby plugin reachability, spawned-shell PATH).',
  args: {},
  async run() {
    // detectTerminal() is env-only; resolveTerminal() adds the plugin-probe
    // fallback so an SSH session (empty TERM_PROGRAM) whose Tabby plugin is
    // reachable reports as usable Tabby rather than a hard ✘.
    const detected = detectTerminal()
    const terminal = resolveTerminal()
    const overrideSet = Boolean(process.env.CCTABS_TERMINAL || process.env.CCTABS_BACKEND)
    const terminalNote =
      overrideSet && terminal === 'tabby'
        ? 'via CCTABS_TERMINAL override'
        : detected === 'unknown' && terminal !== 'unknown'
          ? 'via plugin probe — TERM_PROGRAM unset (SSH?)'
          : undefined

    const shell = resolveTabShell()
    console.log('cctabs doctor — environment checks')
    console.log(
      `  ${process.platform} ${process.arch} · node ${process.versions.node} · ` +
      `tab shell ${shell.command}${shell.posix ? '' : ' (non-POSIX)'}`,
    )
    console.log('─'.repeat(40))

    const results: CheckResult[] = []

    results.push(checkTerminal(terminal, terminalNote))

    // Useful regardless of terminal: every cctabs-spawned tab needs `node` on
    // PATH for the CLI itself and for plugin MCPs that invoke `npx`.
    results.push(checkSpawnedShellPath())
    results.push(checkClaudeInSpawnedShell())

    // Windows only: cctabs works without this, Claude Code does not.
    if (process.platform === 'win32') {
      results.push(checkAgentBashOnPath())
    }

    if (terminal === 'tabby') {
      results.push(checkTabbyPlugin())
    }

    for (const r of results) printResult(r)

    if (results.some(r => r.status === 'fail')) process.exit(1)
  },
})
