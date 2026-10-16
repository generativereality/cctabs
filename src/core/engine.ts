import { ancestorsOf, isClaudeCommand, readProcessTable, type ProcRow } from './claude-procs.js'
import { isCodexCommand, parseEngine, type Engine } from './codex.js'

/** Nearest agent wins: a Claude tool beneath Codex is still a Claude caller. */
export function callerEngine(
  rows: ProcRow[] | null = readProcessTable(),
  selfPid = process.pid,
  env: NodeJS.ProcessEnv = process.env,
): Engine {
  for (const pid of ancestorsOf(selfPid, rows ?? [])) {
    const proc = rows?.find((r) => r.pid === pid)
    if (proc && isClaudeCommand(proc.command)) return 'claude'
    if (proc && isCodexCommand(proc.command)) return 'codex'
  }
  // Codex exports these for its tools, including on Windows where ps is absent.
  // Ambiguous inherited environments retain the historical Claude default.
  return (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) && !env.CLAUDE_CODE_SESSION_ID ? 'codex' : 'claude'
}

/** Explicit engine wins; an explicit Claude backend also selects Claude. */
export function launchEngine(explicit?: string, backend?: string, inherited?: Engine): Engine | null {
  return explicit !== undefined ? parseEngine(explicit) : backend ? 'claude' : inherited ?? callerEngine()
}
