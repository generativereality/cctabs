/**
 * Recovering `send`'s positional arguments from the raw command line.
 *
 * This exists because the option parser silently EATS them. Measured: any argv
 * element containing the substring `--` is dropped from gunshi's positionals
 * and never appears in its values either — `"mentions --verify here"`,
 * `"--leading"`, even `"a--b"`. A single dash survives; `--` anywhere does not.
 *
 * The consequence was a send that reported success and delivered nothing: the
 * text vanished, the command fell through to reading stdin, stdin was empty, and
 * the ✔ line printed with an empty preview. That the payload happened to be a
 * bug report *about* `--file`, `--path` and `--verify` is not an exotic input —
 * it is the normal case for a tool whose users are agents reporting tool bugs,
 * and any message quoting a flag name hits it.
 *
 * So the positionals are read from `process.argv` directly. Flags are still
 * parsed by gunshi (which handles them correctly); only the positionals, which
 * it loses, are recovered here.
 */

/** `send` options that consume the token after them, so it isn't a positional. */
export const SEND_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--file', '-f',
  '--path', '-p',
  '--wait-timeout',
  '--verify-timeout',
])

export interface SendArgv {
  /** The tab or block to send to. */
  target?: string
  /** The inline text, or undefined when none was given on the command line. */
  text?: string
  /**
   * True when the text came after a literal `--`.
   *
   * The explicit escape hatch for text that is *entirely* flag-shaped —
   * `cctabs send tab -- --verify is broken` — where even a positional-recovering
   * walker would otherwise have to guess.
   */
  explicitText: boolean
}

/**
 * Split `send`'s tokens into its two positionals, skipping flags.
 *
 * Only a token that *starts* with `-` is treated as a flag, which is the whole
 * point: `"mentions --verify here"` is one argv element that begins with `m`,
 * so it is free text, exactly as the shell delivered it. A token after `--` is
 * never a flag.
 */
export function parseSendArgv(
  tokens: string[],
  valueFlags: ReadonlySet<string> = SEND_VALUE_FLAGS,
): SendArgv {
  const positionals: string[] = []
  let explicitText = false

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]

    // Everything after a bare `--` is text, joined back with the single spaces
    // the shell split it on. This is the documented escape for flag-shaped text.
    if (t === '--') {
      const rest = tokens.slice(i + 1).join(' ')
      if (positionals.length === 0) {
        // `send -- text` has no target; leave it missing so the caller reports
        // the usage error rather than silently sending to nothing.
        positionals.push('')
      }
      positionals[1] = rest
      explicitText = true
      break
    }

    // A lone `-` is a value (the stdin convention), not a flag.
    if (t.startsWith('-') && t.length > 1) {
      // `--file=x` carries its own value; `--file x` consumes the next token.
      if (!t.includes('=') && valueFlags.has(t)) i++
      continue
    }

    positionals.push(t)
  }

  return {
    target: positionals[0] || undefined,
    text: positionals[1],
    explicitText,
  }
}
