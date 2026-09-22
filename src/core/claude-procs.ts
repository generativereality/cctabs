import { spawnSync } from 'child_process'
import { basename } from 'path'

/**
 * The machine's running Claude Code processes, read from the process table.
 *
 * A second source of truth next to the transcripts, and for one question a
 * better one: which session a running Claude was launched to resume. The
 * by-title transcript search misses a live session in two measured ways — its
 * worktree was renamed, so the transcript sits under the old project slug, or
 * its last on-disk `customTitle` no longer matches the tab — and in both cases
 * the process's own `--resume <id>` still names it exactly.
 *
 * What argv does NOT give reliably is the tab name. `--name` is a spawn-time
 * snapshot: rename the tab afterwards and the process keeps the old name, so a
 * manifest built from argv names lists one session twice under two names. That
 * happened, and restore then spawned a second Claude onto a live session. So:
 * the id comes from argv, the name always comes from the tab list.
 *
 * Nor is `--resume` infallible — a `/clear` inside the session starts a new id
 * the argv never learns about. That is why argv is a fallback for an id the
 * transcripts could not resolve, never an override of one they did.
 */

/** One row of the process table. */
export interface ProcRow {
  pid: number
  ppid: number
  command: string
}

/** A process that is Claude Code itself, with what its argv says. */
export interface ClaudeProc extends ProcRow {
  /** The `--resume` / `-r` session id, when it was launched with one. */
  resumeId?: string
  /** `--session-id`, the other way to pin an id at launch. */
  sessionIdArg?: string
  /** `--name` as it was at spawn time. Stale after a tab rename — see above. */
  name?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse `ps -Ao pid=,ppid=,command=` output. Pure.
 *
 * Lines that don't start with two integers are skipped rather than failing
 * the table: a ps that prints a header, or a truncated last line, must not
 * take every process down with it.
 */
export function parseProcessTable(out: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() })
  }
  return rows
}

/**
 * Is this command line Claude Code itself (not a shell that mentions it)?
 *
 * The first word decides. `zsh -c claude --resume …` is the tab's *shell*,
 * whose argv carries the same flags — counting it would find every session
 * twice, and signalling it would kill the tab rather than the Claude in it.
 */
export function isClaudeCommand(command: string): boolean {
  const argv0 = command.split(/\s+/, 1)[0] ?? ''
  return basename(argv0) === 'claude'
}

/**
 * Pull the flags cctabs cares about out of a Claude command line. Pure.
 *
 * `ps` prints argv joined by spaces with the original quoting gone, so a
 * multi-word `--name` is read up to the next flag. Only a UUID-shaped value is
 * accepted as a session id: `claude --resume` with no id opens a picker, and
 * whatever word follows it is not a session.
 */
export function parseClaudeArgs(command: string): Pick<ClaudeProc, 'resumeId' | 'sessionIdArg' | 'name'> {
  const words = command.split(/\s+/).filter(Boolean)
  const out: Pick<ClaudeProc, 'resumeId' | 'sessionIdArg' | 'name'> = {}

  const valueOf = (i: number, inline: string | undefined): string | undefined =>
    inline !== undefined ? inline : words[i + 1]

  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const eq = w.indexOf('=')
    const flag = w.startsWith('--') && eq > 0 ? w.slice(0, eq) : w
    const inline = w.startsWith('--') && eq > 0 ? w.slice(eq + 1) : undefined

    if (flag === '--resume' || flag === '-r') {
      const v = valueOf(i, inline)
      if (v && UUID.test(v)) out.resumeId = v.toLowerCase()
    } else if (flag === '--session-id') {
      const v = valueOf(i, inline)
      if (v && UUID.test(v)) out.sessionIdArg = v.toLowerCase()
    } else if (flag === '--name' || flag === '-n') {
      if (inline !== undefined) {
        out.name = inline
      } else {
        const parts: string[] = []
        for (let j = i + 1; j < words.length && !words[j].startsWith('-'); j++) parts.push(words[j])
        if (parts.length) out.name = parts.join(' ')
      }
    }
  }
  return out
}

/** The Claude processes in a process table. Pure. */
export function claudeProcsOf(rows: ProcRow[]): ClaudeProc[] {
  return rows
    .filter((r) => isClaudeCommand(r.command))
    .map((r) => ({ ...r, ...parseClaudeArgs(r.command) }))
}

/**
 * The session a Claude process was launched on, from its argv: `--resume`
 * first, then `--session-id`.
 */
export function launchedSessionOf(p: ClaudeProc): string | undefined {
  return p.resumeId ?? p.sessionIdArg
}

/** `[pid, ppid, …]` up to the root, walked through `rows`. Pure. */
export function ancestorsOf(pid: number, rows: ProcRow[], cap = 64): number[] {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]))
  const out = [pid]
  let cur = pid
  for (let i = 0; i < cap; i++) {
    const next = parent.get(cur)
    if (next === undefined || next <= 1 || next === cur || out.includes(next)) break
    out.push(next)
    cur = next
  }
  return out
}

/** Every descendant of `pid` in `rows`, breadth-first. Pure. */
export function descendantsOf(pid: number, rows: ProcRow[]): ProcRow[] {
  const children = new Map<number, ProcRow[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r)
    else children.set(r.ppid, [r])
  }
  const out: ProcRow[] = []
  const seen = new Set<number>([pid])
  const queue = [pid]
  while (queue.length) {
    const cur = queue.shift()!
    for (const c of children.get(cur) ?? []) {
      if (seen.has(c.pid)) continue
      seen.add(c.pid)
      out.push(c)
      queue.push(c.pid)
    }
  }
  return out
}

/**
 * The Claude process this code is running under — the nearest `claude` among
 * our own ancestors. That is the one pid a fleet restart must never signal.
 */
export function ownClaudeProc(rows: ProcRow[], selfPid: number = process.pid): ClaudeProc | undefined {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  for (const pid of ancestorsOf(selfPid, rows)) {
    const r = byPid.get(pid)
    if (r && isClaudeCommand(r.command)) return { ...r, ...parseClaudeArgs(r.command) }
  }
  return undefined
}

/**
 * Read the live process table. Returns `null` where there is no usable `ps`
 * (Windows), so callers can tell "no Claude is running" from "can't tell".
 *
 * `-ww` matters: without it BSD `ps` truncates the command column to the
 * terminal width, and a tab whose `--resume` falls past the cut reads as a
 * Claude with no session — the same trap as `ps aux | grep`.
 */
export function readProcessTable(): ProcRow[] | null {
  if (process.platform === 'win32') return null
  const r = spawnSync('ps', ['-Aww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0 || !r.stdout) return null
  return parseProcessTable(r.stdout)
}

/** A tab reduced to what process matching needs. */
export interface ProcTab {
  tabId: string
  name: string
  /** The tab's own shell pid (the `stable-pid` capability), when reported. */
  shellPid?: number
}

/** How a tab's Claude process was found. */
export type ProcMatchVia =
  /** A Claude beneath the tab's own shell pid. Exact. */
  | 'shell-pid'
  /**
   * The only Claude whose spawn-time `--name` equals the tab's current name.
   * Right unless the tab was renamed onto a name another process still carries,
   * which is why it is only taken when unique in both directions.
   */
  | 'argv-name'

export interface TabProc {
  proc: ClaudeProc
  via: ProcMatchVia
}

/**
 * Pair each tab with the Claude process running in it. Pure.
 *
 * Exact where the backend reports each tab's shell pid: the Claude beneath it
 * is the tab's. Otherwise falls back to `--name`, accepted only when exactly
 * one process carries that name and exactly one tab has it — two tabs or two
 * processes sharing a name are indistinguishable this way, and guessing which
 * process to signal is exactly what a restart must not do. A tab that matches
 * neither way is simply absent from the result.
 */
export function matchTabsToClaude(tabs: ProcTab[], rows: ProcRow[]): Map<string, TabProc> {
  const procs = claudeProcsOf(rows)
  const out = new Map<string, TabProc>()
  const taken = new Set<number>()

  for (const t of tabs) {
    if (!t.shellPid) continue
    const under = descendantsOf(t.shellPid, rows).map((r) => r.pid)
    // Nearest first: descendantsOf is breadth-first, so a Claude a subagent's
    // shell started deeper down never outranks the tab's own.
    const proc = under.map((pid) => procs.find((p) => p.pid === pid)).find(Boolean)
    if (proc) {
      out.set(t.tabId, { proc, via: 'shell-pid' })
      taken.add(proc.pid)
    }
  }

  const tabsByName = new Map<string, number>()
  for (const t of tabs) tabsByName.set(t.name, (tabsByName.get(t.name) ?? 0) + 1)

  for (const t of tabs) {
    if (out.has(t.tabId) || t.shellPid) continue
    if (tabsByName.get(t.name) !== 1) continue
    const named = procs.filter((p) => p.name === t.name && !taken.has(p.pid))
    if (named.length !== 1) continue
    out.set(t.tabId, { proc: named[0], via: 'argv-name' })
    taken.add(named[0].pid)
  }

  return out
}

/** Session id → the Claude pids whose argv launched it. Pure. */
export function liveSessionPids(rows: ProcRow[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const p of claudeProcsOf(rows)) {
    const id = launchedSessionOf(p)
    if (!id) continue
    const list = out.get(id)
    if (list) list.push(p.pid)
    else out.set(id, [p.pid])
  }
  return out
}
