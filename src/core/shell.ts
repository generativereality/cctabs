import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'

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

/**
 * The shell a spawned tab should run, and whether it speaks POSIX.
 *
 * `process.env.SHELL ?? '/bin/zsh'` is right on macOS and Linux and wrong on
 * Windows in both directions, which is why this exists (all measured on
 * Windows 11 ARM64, 2026-09-17):
 *
 *   - Inside a Tabby tab, `SHELL` is NOT set, so the fallback asks Windows to
 *     spawn `/bin/zsh`.
 *   - Over SSH it IS set — Windows OpenSSH exports it as
 *     `…\WindowsPowerShell\v1.0\powershell.exe` — so the POSIX launch line is
 *     handed to PowerShell, which answers `-l : The term '-l' is not
 *     recognized…` and `exec : The term 'exec' is not recognized…`. The tab
 *     opens, `cctabs new` prints `√ Tab "x" → claude` and exits 0, and Claude
 *     was never started. A success report over an empty tab is the worst of
 *     the available failures.
 *
 * So on Windows, look for a POSIX shell that can actually run the launch line
 * (Git Bash is the realistic one, and `git` is already a cctabs dependency for
 * worktrees), and fall back to `cmd.exe` with a cmd-shaped launch rather than
 * emitting POSIX syntax into a shell that cannot parse it.
 */
export interface TabShell {
  /** Executable to spawn. */
  command: string
  /** True when `command` understands `-l -i -c` and POSIX syntax. */
  posix: boolean
}

const POSIX_SHELL_RE = /^(zsh|bash|sh|dash|ash|ksh|mksh|fish)(\.exe)?$/i

function looksPosix(command: string): boolean {
  const base = command.split(/[\\/]/).pop() ?? ''
  return POSIX_SHELL_RE.test(base)
}

/**
 * Git Bash, derived from whatever `git` is on PATH so a custom install works.
 *
 * Exported because `cctabs doctor` needs the same answer for a different question:
 * cctabs can run without `bash` on PATH, but Claude Code's Bash tool cannot, and the
 * doctor can only name the directory to add if it knows where Git Bash actually is.
 */
export function findGitBash(): string | undefined {
  const r = spawnSync('where', ['git.exe'], { encoding: 'utf-8' })
  const gitExe = (r.stdout ?? '').split(/\r?\n/).find((l) => l.trim().endsWith('git.exe'))?.trim()
  if (gitExe) {
    // The installer puts <root>\cmd on PATH, so git.exe resolves while
    // bash.exe (<root>\bin) does not. Derive the sibling rather than
    // requiring the user to add it.
    const candidate = join(dirname(dirname(gitExe)), 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
  }
  for (const p of [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ]) {
    if (existsSync(p)) return p
  }
  return undefined
}

export function resolveTabShell(platformName: string = process.platform): TabShell {
  // Explicit override always wins - the escape hatch for an unusual setup.
  const override = process.env.CCTABS_SHELL?.trim()
  if (override) return { command: override, posix: looksPosix(override) }

  if (platformName !== 'win32') {
    return { command: process.env.SHELL ?? '/bin/zsh', posix: true }
  }

  const fromEnv = process.env.SHELL?.trim()
  if (fromEnv && looksPosix(fromEnv)) return { command: fromEnv, posix: true }

  const bash = findGitBash()
  if (bash) return { command: bash, posix: true }

  return { command: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe', posix: false }
}

/**
 * The `{command, args}` that starts `body` in a tab and leaves the shell alive
 * afterwards, so the tab does not vanish when Claude exits.
 *
 * ⛔ The POSIX form quotes the shell path. It did not, and on Windows the
 * default Git install (`C:\Program Files\Git\bin\bash.exe`) made bash split the
 * trailing `exec` on the space: `bash: exec: C:Program: not found`, visible in
 * the tab while the CLI reported success.
 */
export function tabLaunchArgv(shell: TabShell, body: string): string[] {
  if (shell.posix) {
    return ['-l', '-i', '-c', `${body}; exec ${shellQuoteArg(shell.command)} -l -i`]
  }
  // cmd.exe: /k runs the command and keeps the shell. No `exec`, and the
  // POSIX `VAR=value cmd` prefix is not cmd syntax - callers build `set`
  // statements for the non-POSIX case instead.
  return ['/k', body]
}

/** `KEY=value ` prefix (POSIX) or `set "KEY=value" && ` (cmd). */
export function envPrefixFor(shell: TabShell, env: Record<string, string> | undefined): string {
  const entries = Object.entries(env ?? {})
  if (!entries.length) return ''
  return shell.posix
    ? entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') + ' '
    : entries.map(([k, v]) => `set "${k}=${v}"`).join(' && ') + ' && '
}
