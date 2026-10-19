/**
 * Keeping text that contains `--` from being parsed as an option. Pure.
 *
 * The tokenizer under gunshi (args-tokens 0.17) decides an argv element is a
 * long option with `~arg.indexOf('--')`: true when `--` appears ANYWHERE in it.
 * So `"run publish.sh --push to ship"` — one argv element, a message that
 * quotes a flag — became an option named `n publish.sh --push to ship`. `send`
 * then refused it as an unknown option ("is not an option of cctabs send.
 * Nothing was run."), and `new --prompt "<that>"` lost its value and failed
 * with "Optional argument '--prompt' should be 'string'" (both hit by the
 * brands-dev tab, 2026-10-17..19).
 *
 * The fix is to decide option-ness ourselves, before the tokenizer sees the
 * argv: an element is an option only if it is SHAPED like one (`--name`,
 * `--name=value`, `-x`). Anything else that would fool the tokenizer is
 * disguised for the trip through it — every `-` swapped for a private-use
 * character — and restored in the parsed result. A disguised element can only
 * ever come out as a positional or as an option's value, which is what it is.
 */

/** Stands in for `-` inside protected text. Private use, so never typed. */
const DASH_STANDIN = ''

/**
 * Is this argv element an option, as opposed to text? Pure.
 *
 * `--name` and `--name=anything` (the value may hold spaces and dashes), and
 * short flags `-x` / `-xyz` / `-1`. Not `-` (the stdin convention) and not a
 * bare `--` (the terminator) — callers treat those themselves.
 */
export function isOptionShaped(arg: string): boolean {
  return /^--[A-Za-z0-9][\w-]*(=[\s\S]*)?$/.test(arg) || /^-[A-Za-z0-9]+$/.test(arg)
}

/** Would the tokenizer misread this text as an option? */
function foolsTokenizer(arg: string): boolean {
  if (arg === '-' || arg === '--' || isOptionShaped(arg)) return false
  if (arg.includes(DASH_STANDIN)) return false // can't round-trip; leave it be
  return arg.includes('--') || (arg.startsWith('-') && arg.length > 1)
}

/** Disguise every text element the tokenizer would take for an option. */
export function protectArgv(argv: readonly string[]): string[] {
  return argv.map((a) => (foolsTokenizer(a) ? a.split('-').join(DASH_STANDIN) : a))
}

/** Undo `protectArgv` on one parsed string. */
export function restoreText(s: string): string {
  return s.includes(DASH_STANDIN) ? s.split(DASH_STANDIN).join('-') : s
}

/**
 * Undo `protectArgv` throughout a parsed value: strings, and the strings in
 * arrays and plain objects (`values`, `positionals`, tokens). Returns copies,
 * because gunshi hands commands a deep-frozen context.
 */
export function restoreParsed<T>(v: T): T {
  if (typeof v === 'string') return restoreText(v) as T
  if (Array.isArray(v)) return v.map((x) => restoreParsed(x)) as T
  if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = restoreParsed(x)
    return out as T
  }
  return v
}
