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
    `  cctabs currently requires Wave Terminal.`,
    `  You appear to be running in: ${name}`,
    '',
    `  Option 1 — Switch to Wave Terminal (full support today):`,
    `    brew install --cask wave`,
    `    https://waveterm.dev`,
    '',
    `  Option 2 — Add ${name} support (one adapter file, PRs welcome):`,
    `    git clone ${repo}`,
    `    cd cctabs`,
    `    claude   # ask Claude to implement the ${name} adapter`,
    '',
    `    Claude will find src/core/wave.ts, use it as the reference`,
    `    implementation, create src/core/${adapterFileName(terminal)},`,
    `    wire it up, and open a PR — all in one session.`,
    '',
  ]

  console.error(lines.join('\n'))
}

function adapterFileName(terminal: KnownTerminal): string {
  if (terminal === 'unknown') return '<terminal>.ts'
  return `${terminal}.ts`
}
