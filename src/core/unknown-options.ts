/**
 * Rejecting options a command doesn't declare.
 *
 * gunshi parses an undeclared flag without complaint: it lands in neither
 * `values` nor `positionals` and the command runs as if it were never typed.
 * Measured on 0.5.4 — `cctabs sessions --bogus-flag` exits 0 and prints the
 * session list.
 *
 * That is worse than it sounds, because the flags most likely to be typed by
 * mistake are the ones that exist on a *neighbouring* command. `cctabs new
 * <name> <dir> --path <file>` printed its success line and opened the tab, and
 * the brief it was supposed to deliver went nowhere: `--path` is a `send`
 * option, `new` has `--prompt`/`--file`, and nothing said so. The tab sat idle
 * until a human noticed. A non-zero exit and a one-line message is the whole
 * fix, and it belongs to every command rather than to `new`.
 */

/** The shape of one entry in a gunshi `args` declaration. */
export interface ArgSpecLike {
  type: string
  short?: string
}

/** The fields of a gunshi/args-tokens token that matter here. */
export interface ArgTokenLike {
  kind: string
  name?: string
  rawName?: string
}

/** Parsed and handled by gunshi itself, so never "unknown". */
const BUILTIN_OPTIONS: ReadonlySet<string> = new Set(['help', 'h', 'version', 'v'])

/**
 * Options present on the command line that `args` does not declare, in the
 * order typed, as they were written (`--path`, `-z`). Empty when all are known.
 */
export function findUnknownOptions(
  tokens: readonly ArgTokenLike[],
  args: Readonly<Record<string, ArgSpecLike>>,
): string[] {
  const longs = new Set<string>()
  const shorts = new Set<string>()
  const booleans = new Set<string>()
  for (const [name, spec] of Object.entries(args ?? {})) {
    if (spec?.type === 'positional') continue
    longs.add(name)
    if (spec?.short) shorts.add(spec.short)
    if (spec?.type === 'boolean') booleans.add(name)
  }

  const unknown: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    // Everything after a literal `--` is payload, not options — that is the
    // terminator `send` documents for flag-shaped text.
    if (token.kind === 'option-terminator') break
    if (token.kind !== 'option') continue

    const name = token.name ?? ''
    if (!name) continue
    if (BUILTIN_OPTIONS.has(name)) continue
    if (longs.has(name) || shorts.has(name)) continue
    // `--no-verbose` is how a declared boolean is turned off.
    if (name.startsWith('no-') && booleans.has(name.slice(3))) continue

    const raw = token.rawName ?? (name.length === 1 ? `-${name}` : `--${name}`)
    if (seen.has(raw)) continue
    seen.add(raw)
    unknown.push(raw)
  }
  return unknown
}

/**
 * The message shown when an option isn't recognised.
 *
 * Names the command, because the likeliest cause is a flag borrowed from a
 * sibling — and points at `--help` rather than listing every option here.
 */
export function unknownOptionMessage(command: string, unknown: string[]): string {
  const which = unknown.map((u) => `\`${u}\``).join(', ')
  const plural = unknown.length > 1 ? 'are not options' : 'is not an option'
  return `${which} ${plural} of \`cctabs ${command}\`. Nothing was run. See \`cctabs ${command} --help\`.`
}
