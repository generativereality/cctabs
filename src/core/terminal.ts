// Terminal detection and unsupported-terminal messaging

export type KnownTerminal =
  | 'wave'
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
  if (process.env.WAVETERM_JWT) return 'wave'

  const prog = process.env.TERM_PROGRAM ?? ''
  const term = process.env.TERM ?? ''

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

const TERMINAL_NAMES: Record<KnownTerminal, string> = {
  wave: 'Wave Terminal',
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
