// Terminal detection and unsupported-terminal messaging

import { spawnSync } from 'child_process'

export type KnownTerminal =
  | 'wave'
  | 'tabby'
  | 'iterm2'
  | 'ghostty'
  | 'warp'
  | 'kitty'
  | 'vscode'
  | 'hyper'
  | 'alacritty'
  | 'apple-terminal'
  | 'unknown'

export function detectTerminal(): KnownTerminal {
  // Explicit override wins over env sniffing. Essential over SSH, where the
  // parent terminal never exported TERM_PROGRAM into our session even though a
  // real, reachable terminal (e.g. Tabby with the cctabs plugin) is running on
  // this host. CCTABS_TERMINAL is the documented name; CCTABS_BACKEND is
  // accepted as an alias for people who think in "backend" terms.
  const override = (process.env.CCTABS_TERMINAL ?? process.env.CCTABS_BACKEND ?? '')
    .trim()
    .toLowerCase()
  if (override && isKnownTerminal(override)) return override

  const prog = process.env.TERM_PROGRAM ?? ''
  const term = process.env.TERM ?? ''

  // TERM_PROGRAM is set by the actual parent terminal at shell startup.
  // Check Tabby first because WAVETERM_JWT can leak into Tabby child shells
  // when Tabby was launched from a Wave session (`open -a Tabby`), and we
  // want the *current* terminal to win.
  if (prog === 'Tabby') return 'tabby'

  // Wave is still *detected* even though its adapter was removed in 0.5.0 —
  // recognising it is what lets requireAdapter() explain that support was
  // withdrawn instead of reporting "an unrecognised terminal".
  if (process.env.WAVETERM_JWT) return 'wave'

  if (prog === 'iTerm.app') return 'iterm2'
  if (prog === 'ghostty' || process.env.GHOSTTY_RESOURCES_DIR) return 'ghostty'
  if (prog === 'WarpTerminal') return 'warp'
  if (prog === 'vscode') return 'vscode'
  if (prog === 'Hyper') return 'hyper'
  if (prog === 'Apple_Terminal') return 'apple-terminal'
  if (term === 'xterm-kitty' || process.env.KITTY_WINDOW_ID) return 'kitty'
  if (term === 'alacritty') return 'alacritty'

  return 'unknown'
}

const ALL_TERMINALS: readonly KnownTerminal[] = [
  'wave',
  'tabby',
  'iterm2',
  'ghostty',
  'warp',
  'kitty',
  'vscode',
  'hyper',
  'alacritty',
  'apple-terminal',
  'unknown',
]

function isKnownTerminal(v: string): v is KnownTerminal {
  return (ALL_TERMINALS as readonly string[]).includes(v)
}

/**
 * Like {@link detectTerminal} but, when env sniffing yields 'unknown', probes
 * the Tabby cctabs plugin on this host and resolves to 'tabby' if it answers.
 *
 * The probe only fires in the unknown case — a session with a recognised
 * TERM_PROGRAM (or an explicit CCTABS_TERMINAL override) never pays for the
 * network round-trip. This is the path that lets `ssh host 'cctabs …'` drive a
 * running Tabby: over SSH TERM_PROGRAM is empty, but the plugin is still
 * listening on 127.0.0.1:3300. Synchronous (a short curl) so it can slot into
 * the existing sync adapter/doctor code without rippling async through every
 * caller; keep it out of hot loops.
 */
export function resolveTerminal(): KnownTerminal {
  const t = detectTerminal()
  if (t !== 'unknown') return t
  return tabbyPluginResponds() ? 'tabby' : 'unknown'
}

/** True if the Tabby cctabs plugin answers /api/health with {ok:true}. */
export function tabbyPluginResponds(): boolean {
  const host = process.env.CCTABS_TABBY_HOST ?? '127.0.0.1'
  const port = Number(process.env.CCTABS_TABBY_PORT ?? '3300')
  const r = spawnSync(
    'curl',
    ['-fsS', '--max-time', '2', `http://${host}:${port}/api/health`],
    { encoding: 'utf-8' },
  )
  if (r.status !== 0 || !r.stdout) return false
  try {
    return Boolean((JSON.parse(r.stdout) as { ok?: boolean }).ok)
  } catch {
    return false
  }
}

const TERMINAL_NAMES: Record<KnownTerminal, string> = {
  wave: 'Wave Terminal',
  tabby: 'Tabby',
  iterm2: 'iTerm2',
  ghostty: 'Ghostty',
  warp: 'Warp',
  kitty: 'Kitty',
  vscode: 'VS Code terminal',
  hyper: 'Hyper',
  alacritty: 'Alacritty',
  'apple-terminal': 'Terminal.app',
  unknown: 'an unrecognised terminal',
}

export function printUnsupportedTerminalError(terminal: KnownTerminal): void {
  const name = TERMINAL_NAMES[terminal]
  const repo = 'https://github.com/generativereality/cctabs'

  const lines: string[] = [
    '',
    `  cctabs requires Tabby.`,
    `  You appear to be running in: ${name}`,
    '',
    `  Option 1 — Switch to Tabby (the supported terminal):`,
    `    brew install --cask tabby`,
    `    cctabs install-tabby-plugin   # run this from inside a Tabby tab`,
    `    https://cctabs.com/guide/getting-started`,
    '',
    `  Option 2 — Add ${name} support (one adapter file, PRs welcome):`,
    `    git clone ${repo}`,
    `    cd cctabs`,
    `    claude   # ask Claude to implement the ${name} adapter`,
    '',
    `    Claude will find src/core/tabby.ts, use it as the reference`,
    `    implementation, create src/core/${adapterFileName(terminal)},`,
    `    wire it up, and open a PR — all in one session.`,
    '',
  ]

  console.error(lines.join('\n'))
}

/**
 * Wave gets its own message rather than falling into the generic
 * unsupported-terminal path: Wave *was* supported through 0.4.x, so a user
 * hitting this is more likely to be an existing user whose setup just stopped
 * working than someone picking a terminal for the first time. Say plainly that
 * support was withdrawn, and why, so it doesn't read as a bug.
 */
export function printWaveWithdrawnError(): void {
  const lines: string[] = [
    '',
    `  cctabs no longer supports Wave Terminal.`,
    '',
    `  Wave support was withdrawn in 0.5.0. It had degraded to the point`,
    `  where tabs would open but the Claude session inside them often never`,
    `  started, and diagnosing that cost more than the backend was worth.`,
    `  Tabby is the supported terminal and is where the work goes now.`,
    '',
    `  Switch to Tabby:`,
    `    brew install --cask tabby`,
    `    cctabs install-tabby-plugin   # run this from inside a Tabby tab`,
    `    https://cctabs.com/guide/getting-started`,
    '',
    `  Your Claude sessions are not tied to the terminal — they live in`,
    `  ~/.claude/projects. Once Tabby is running, \`cctabs restore\` will`,
    `  reopen them by name.`,
    '',
  ]

  console.error(lines.join('\n'))
}

function adapterFileName(terminal: KnownTerminal): string {
  if (terminal === 'unknown') return '<terminal>.ts'
  return `${terminal}.ts`
}
