/**
 * POSIX single-quote escape one argv token. Several commands join the
 * configured `claude.flags` into a raw shell string and send it as terminal
 * input, so any value with shell metacharacters must be quoted or the shell
 * mangles it before `claude` sees it — e.g. a `--model opus[1m]` flag
 * glob-expands under zsh ("no matches found: opus[1m]") and the launch
 * silently falls back to the default model. Single quotes are inert in every
 * POSIX shell; embedded single quotes are closed, escaped, and reopened ('\'').
 */
export function shellQuoteArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}
