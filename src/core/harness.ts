/**
 * Other agent harnesses as the program in a tab: opencode, pi and Hermes. Pure.
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
 *   hermes    https://hermes-agent.nousresearch.com/docs/reference/cli-commands
 *             `hermes chat -q/--query`: "On a real TTY the prompt is submitted
 *             literally as the first turn of a normal interactive session … and
 *             the session stays open"; `-m/--model`, `-r/--resume <session>`.
 */

export type Harness = 'opencode' | 'pi' | 'hermes'
export const HARNESSES: readonly Harness[] = ['opencode', 'pi', 'hermes']

export function parseHarness(v: string | undefined): Harness | null {
  return (HARNESSES as readonly string[]).includes(v ?? '') ? v as Harness : null
}

export const HARNESS_LABEL: Record<Harness, string> = { opencode: 'opencode', pi: 'pi', hermes: 'Hermes' }

export const HARNESS_INSTALL: Record<Harness, string> = {
  opencode: 'npm install -g opencode-ai (or https://opencode.ai/docs/)',
  pi: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent (or https://pi.dev)',
  hermes: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
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
  } else if (engine === 'pi') {
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--session', o.resumeId)
    if (o.name && !o.resumeId) out.push('--name', o.name)
    if (o.prompt !== undefined) out.push('--', o.prompt)
  } else {
    out.push('chat')
    if (o.model) out.push('--model', o.model)
    if (o.resumeId) out.push('--resume', o.resumeId)
    if (o.prompt !== undefined) out.push(`--query=${o.prompt}`)
  }
  return out
}

/** Is this command line one of these harnesses (for telling a tab's program apart)? */
export function harnessOfCommand(command: string): Harness | null {
  const first = (command.trim().match(/^"[^"]*"|^\S+/)?.[0] ?? '').replace(/^"|"$/g, '')
  const base = (first.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|js)$/i, '').toLowerCase()
  return parseHarness(base)
}
