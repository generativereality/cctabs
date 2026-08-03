import { spawnSync } from 'child_process'
import { define } from 'gunshi'
import { detectTerminal, resolveTerminal, type KnownTerminal } from '../core/terminal.js'

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
      'Or do it by hand: `npm install --legacy-peer-deps --prefix "$HOME/Library/Application Support/tabby/plugins" tabby-cctabs`, then quit + reopen Tabby.',
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
  const r = spawnSync('zsh', ['-l', '-i', '-c', 'command -v node'], {
    encoding: 'utf-8',
    timeout: 3000,
  })
  if (r.status === 0 && r.stdout?.trim()) {
    return {
      name: 'Spawned shell PATH (node findable)',
      status: 'ok',
      detail: r.stdout.trim(),
    }
  }
  return {
    name: 'Spawned shell PATH',
    status: 'warn',
    detail: r.error?.message ?? r.stderr?.trim() ?? 'node not found in a login+interactive zsh',
    hint:
      'A login+interactive zsh cannot find `node`. Either node is not installed, or PATH is broken. ' +
      'cctabs spawns tabs with `zsh -l -i -c` so both ~/.zprofile and ~/.zshrc are sourced — ' +
      'if your PATH-extending logic lives elsewhere (e.g. a sourced file that bails on non-interactive), ' +
      'move the `export PATH=...` lines into ~/.zshenv as a belt-and-braces fix.',
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

    console.log('cctabs doctor — environment checks')
    console.log('─'.repeat(40))

    const results: CheckResult[] = []

    results.push(checkTerminal(terminal, terminalNote))

    // Useful regardless of terminal: every cctabs-spawned tab needs `node` on
    // PATH for the CLI itself and for plugin MCPs that invoke `npx`.
    results.push(checkSpawnedShellPath())

    if (terminal === 'tabby') {
      results.push(checkTabbyPlugin())
    }

    for (const r of results) printResult(r)

    if (results.some(r => r.status === 'fail')) process.exit(1)
  },
})
