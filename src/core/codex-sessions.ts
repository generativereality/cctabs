import { closeSync, openSync, readSync, readdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ancestorsOf, descendantsOf, isClaudeCommand, type ProcRow, type ProcTab } from './claude-procs.js'
import { isCodexCommand, commandWords } from './codex.js'

export interface CodexSession { id: string; cwd: string; startedAt: number; file: string; forkedFromId?: string }
const isWrapper = (command: string) => /(?:^|[\\/])node(?:\.exe)?$/i.test(commandWords(command)[0] ?? '')
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

/** Read only the metadata line, never the potentially huge conversation. */
export function readCodexSessions(root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')): CodexSession[] {
  const out: CodexSession[] = []
  const walk = (dir: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const ent of entries) {
      const file = join(dir, ent.name)
      if (ent.isDirectory()) { walk(file); continue }
      if (!ent.name.startsWith('rollout-') || !ent.name.endsWith('.jsonl')) continue
      let fd: number | undefined
      try {
        fd = openSync(file, 'r')
        const buf = Buffer.alloc(65536)
        const n = readSync(fd, buf, 0, buf.length, 0)
        const row = JSON.parse(buf.toString('utf8', 0, n).split('\n')[0])
        const p = row.payload
        const id = p?.session_id ?? p?.id
        const startedAt = Date.parse(p?.timestamp ?? row.timestamp)
        if (row.type === 'session_meta' && uuid.test(id) && typeof p.cwd === 'string' && Number.isFinite(startedAt)) {
          out.push({ id, cwd: p.cwd, startedAt, file, ...(typeof p.forked_from_id === 'string' ? { forkedFromId: p.forked_from_id } : {}) })
        }
      } catch { /* partially written or inaccessible rollout */ }
      finally { if (fd !== undefined) closeSync(fd) }
    }
  }
  walk(root)
  return out
}

/** Only a UUID immediately following the resume subcommand is accepted. */
export function codexResumeId(command: string): string | undefined {
  return codexSubcommandId(command, 'resume')
}

export function codexForkId(command: string): string | undefined {
  return codexSubcommandId(command, 'fork')
}

function codexSubcommandId(command: string, subcommand: string): string | undefined {
  if (!isCodexCommand(command)) return undefined
  const words = commandWords(command)
  const at = /(?:^|[\\/])node(?:\.exe)?$/i.test(words[0]) ? 2 : 1
  if (words[at] !== subcommand) return undefined
  // Flags may precede the id; UUID-shaped prompts aren't resume ids on fresh launches.
  return words.slice(at + 1).find((w) => uuid.test(w))?.toLowerCase()
}

export function matchCodexTabs(tabs: ProcTab[], rows: ProcRow[], sessions: CodexSession[]): Map<string, { proc: ProcRow; session?: CodexSession; id?: string }> {
  const out = new Map<string, { proc: ProcRow; session?: CodexSession; id?: string }>()
  const possibilities = new Map<string, CodexSession[]>()
  for (const tab of tabs) {
    if (!tab.shellPid) continue
    const root = rows.find((r) => r.pid === tab.shellPid)
    // Prefer the native child to the npm wrapper: it owns the TUI and its cwd.
    const under = [...(root ? [root] : []), ...descendantsOf(tab.shellPid, rows)].filter((r) => isCodexCommand(r.command))
    const proc = under.find((r) => !isWrapper(r.command)) ?? under[0]
    if (!proc) continue
    // A Codex tool started by Claude does not own Claude's terminal tab.
    const chain = ancestorsOf(proc.pid, rows)
    const tabAt = chain.indexOf(tab.shellPid)
    if (chain.slice(1, tabAt < 0 ? undefined : tabAt).some((pid) => rows.some((r) => r.pid === pid && isClaudeCommand(r.command)))) continue
    const id = codexResumeId(proc.command)
    if (id) { out.set(tab.tabId, { proc, id, session: sessions.find((s) => s.id === id) }); continue }
    const forkedFromId = codexForkId(proc.command)
    const candidates = sessions.filter((s) => s.forkedFromId === forkedFromId && sameCodexCwd(proc.cwd ?? tab.cwd, s.cwd) && proc.startedAt !== undefined && s.startedAt >= proc.startedAt && s.startedAt - proc.startedAt < 120_000)
    possibilities.set(tab.tabId, candidates)
    out.set(tab.tabId, { proc, ...(candidates.length === 1 ? { id: candidates[0].id, session: candidates[0] } : {}) })
  }
  // Two fresh processes in one directory can both fit one rollout. Never guess.
  const counts = new Map<string, number>()
  for (const [tab, m] of out) {
    for (const id of possibilities.has(tab) ? possibilities.get(tab)!.map((s) => s.id) : m.id ? [m.id] : []) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  for (const [tab, match] of out) {
    if (!match.id || codexResumeId(match.proc.command)) continue
    if ((counts.get(match.id) ?? 0) > 1) out.set(tab, { proc: match.proc })
  }
  return out
}

export function codexLiveSessionPids(rows: ProcRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const native = rows.filter((r) => isCodexCommand(r.command) && !isWrapper(r.command))
  const matches = matchCodexTabs(native.map((r) => ({ tabId: String(r.pid), name: '', shellPid: r.pid })), rows, readCodexSessions())
  for (const m of matches.values()) {
    if (m.id) out.set(m.id, [...(out.get(m.id) ?? []), m.proc.pid])
  }
  return out
}

export function sameCodexCwd(a: string | undefined, b: string): boolean {
  const normalize = (p: string) => {
    const raw = p.replaceAll('\\', '/')
    const slash = /^\/\/\?\/UNC\//i.test(raw) ? '//' + raw.slice(8) : raw.replace(/^\/\/\?\//, '')
    if (/^[a-z]:\//i.test(slash) || slash.startsWith('//')) return slash.toLowerCase()
    try { return realpathSync.native(p) } catch { return p }
  }
  return a !== undefined && normalize(a) === normalize(b)
}
