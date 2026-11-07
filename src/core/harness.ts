/**
 * Other agent harnesses as the program in a tab: opencode (1.x and 2.x), pi,
 * oh-my-pi, Hermes and Grok Build. Pure.
 *
 * Launch-only for now: `cctabs new --engine <harness>` opens a named tab that
 * starts the harness's interactive TUI, with the first turn, the model and a
 * session to resume passed on argv. Status, fork, suspend and restore still
 * know only Claude and Codex; those tabs read as plain tabs until they do.
 *
 * Flags are from each project's own docs (read 2026-11-04):
 *
 *   opencode  https://opencode.ai/docs/cli/
 *             `opencode [project]` starts the TUI; `--prompt` "Prompt to use",
 *             `-m/--model` provider/model, `-s/--session` "Session ID to continue".
 *             (`opencode run` is the non-interactive mode, not used here.)
 *   pi        https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md
 *             `pi [options] [--] [messages...]`: a message is "an initial prompt"
 *             and the TUI stays open (`-p/--print` is the one-shot mode);
 *             `--model <pattern>`, `--session <path|id>`, `-n/--name <name>`.
 *   omp       oh-my-pi, the pi fork (@oh-my-pi/pi-coding-agent 18.18.0, src/cli/args.ts
 *             and src/cli/flag-tables.ts, read 2026-11-07): `omp [options] [--] [messages...]`
 *             like pi, with `--model`, `--resume/--session <id|path>`; no `--name`.
 *             Runs on Bun (>= 1.4.4), so its process reads `bun …/omp`.
 *   hermes    https://hermes-agent.nousresearch.com/docs/reference/cli-commands
 *             `hermes chat -q/--query`: "On a real TTY the prompt is submitted
 *             literally as the first turn of a normal interactive session … and
 *             the session stays open"; `-m/--model`, `-r/--resume <session>`.
 *   opencode2 https://opencode.ai/v2/docs/cli and the root command's flags in
 *             anomalyco/opencode packages/cli/src/commands/commands.ts (dev @ ffe6fed,
 *             read 2026-11-04): `opencode [directory]` with `--prompt` "Prompt to
 *             use", `-s/--session` "Session ID to continue, or to create if it does
 *             not exist", `-c/--continue`. No `--model` on the root command (only
 *             `mini` and `run` take one), so cctabs refuses `-m` for it. The TUI
 *             auto-submits `--prompt` once it is ready (packages/tui/src/routes/home.tsx).
 *             Same binary name as 1.x: `opencode`.
 *   grok      https://docs.x.ai/build/cli/reference: "Running `grok` with no
 *             arguments starts the interactive TUI"; `-m/--model <MODEL>`,
 *             `-r/--resume [<ID>]`. The only documented prompt is headless
 *             (`grok -p`, https://docs.x.ai/build/cli/headless-scripting), so
 *             cctabs refuses `--prompt` for Grok rather than guess a TUI flag.
 */

export type Harness = 'opencode' | 'opencode2' | 'pi' | 'omp' | 'hermes' | 'grok'
export const HARNESSES: readonly Harness[] = ['opencode', 'opencode2', 'pi', 'omp', 'hermes', 'grok']

export function parseHarness(v: string | undefined): Harness | null {
  return (HARNESSES as readonly string[]).includes(v ?? '') ? v as Harness : null
}

export const HARNESS_LABEL: Record<Harness, string> = { opencode: 'opencode', opencode2: 'opencode 2', pi: 'pi', omp: 'oh-my-pi', hermes: 'Hermes', grok: 'Grok Build' }

/** The program each harness runs: opencode 2 kept 1.x's binary name. */
export const HARNESS_BIN: Record<Harness, string> = { opencode: 'opencode', opencode2: 'opencode', pi: 'pi', omp: 'omp', hermes: 'hermes', grok: 'grok' }

/**
 * Why this harness cannot take what was asked on its launch line, or null. Pure.
 * Refusing beats guessing a flag the harness would reject or misread.
 */
export function harnessUnsupported(engine: Harness, o: { prompt?: string; model?: string }): string | null {
  if (engine === 'opencode2' && o.model) return 'opencode 2 has no --model on its launch line (only `opencode mini` and `opencode run` take one). Open the tab without -m and pick the model in its TUI.'
  if (engine === 'grok' && o.prompt !== undefined) return 'Grok Build documents no way to start its TUI with a first prompt (only headless `grok -p`). Open the tab without --prompt/--file and send the prompt with `cctabs send`.'
  return null
}

export const HARNESS_INSTALL: Record<Harness, string> = {
  opencode: 'npm install -g opencode-ai (or https://opencode.ai/docs/)',
  opencode2: 'npm install -g @opencode/cli (or https://opencode.ai/v2/docs/)',
  pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent (or https://pi.dev)',
  omp: 'bun add -g @oh-my-pi/pi-coding-agent (needs Bun 1.4.4 or later; or https://omp.sh)',
  hermes: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
  grok: 'see https://docs.x.ai/build/cli/reference',
}

/**
 * The words after the harness's binary on the launch line. Pure.
 *
 * A prompt is joined to its flag (`--prompt=…`, `--query=…`) or put after
 * `--` (pi), so a prompt that starts with `-` is never read as a flag.
 */
export function harnessArgs(engine: Harness, o: { prompt?: string; resumeId?: string; model?: string; name?: string }): string[] {
  const out: string[] = []
  if (engine === 'opencode') {
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--session', o.resumeId)
    if (o.prompt !== undefined) out.push(`--prompt=${o.prompt}`)
  } else if (engine === 'opencode2') {
    if (o.resumeId) out.push('--session', o.resumeId)
    if (o.prompt !== undefined) out.push(`--prompt=${o.prompt}`)
  } else if (engine === 'grok') {
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--resume', o.resumeId)
  } else if (engine === 'pi') {
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--session', o.resumeId)
    if (o.name && !o.resumeId) out.push('--name', o.name)
    if (o.prompt !== undefined) out.push('--', o.prompt)
  } else if (engine === 'omp') {
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--resume', o.resumeId)
    if (o.prompt !== undefined) out.push('--', o.prompt)
  } else {
    out.push('chat')
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--resume', o.resumeId)
    if (o.prompt !== undefined) out.push(`--query=${o.prompt}`)
  }
  return out
}

/** The program a command line runs, lower-cased, without its folder or extension. Pure. */
function programBase(word: string): string {
  return (word.replace(/^"|"$/g, '').split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|js)$/i, '').toLowerCase()
}

/** Runtimes a harness's script runs under (oh-my-pi's process reads `bun …/omp`). */
const RUNTIMES = new Set(['bun', 'node', 'deno'])

/** Is this command line one of these harnesses (for telling a tab's program apart)? */
export function harnessOfCommand(command: string): Harness | null {
  const words = command.trim().match(/"[^"]*"|\S+/g) ?? []
  const base = programBase(words[0] ?? '')
  // opencode 1.x and 2.x share a binary; the command line cannot tell them apart.
  if (!RUNTIMES.has(base)) return parseHarness(base)
  // `bun /opt/homebrew/bin/omp …`: the script is the first word that is not a runtime flag.
  const script = words.slice(1).find((w) => !w.startsWith('-'))
  return script ? parseHarness(programBase(script)) : null
}
