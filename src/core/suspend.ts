import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PermissionMode } from '../types/index.js'
import { descendantsOf, isClaudeCommand, type ProcRow } from './claude-procs.js'
import { isSuspended, SUSPEND_MARKER } from './session-status.js'
import { shellQuoteArg, type TabShell } from './shell.js'

/**
 * Suspended tabs: a tab that keeps its name and knows its Claude session, but
 * runs no Claude — a small shell placeholder that waits for a keypress and
 * then resumes the session in place.
 *
 * Why this exists: restoring a 66-session fleet takes minutes, trips the
 * plugin's spawn timeouts, and floods claude.ai's remote-control list so the
 * sessions that matter fall out of its visible top 20. Most of those sessions
 * are idle. A placeholder costs one idle shell and nothing on claude.ai.
 *
 * Three signals say a tab is suspended, in this order of trust:
 *
 *   1. **The placeholder's own process.** Its argv starts with
 *      `true cctabs-suspended <session-id>`, so `ps` names the session it is
 *      holding without anyone reading a screen. Beneath it, once woken, runs
 *      the Claude it launched — which is how "woken" is told from "waiting".
 *   2. **The registry** — one JSON file per suspended session under
 *      `~/.config/cctabs/suspended/`. The source of truth for what to relaunch,
 *      and the only signal left when a tab exists but its process does not
 *      (Tabby restarted and hasn't spawned it yet), or where there is no `ps`.
 *   3. **The on-screen marker**, `⏸ cctabs suspended — …`. The human
 *      affordance, and a last-resort fallback: Tabby captures nothing for a
 *      tab whose PTY hasn't attached, so a screen can't be the source of truth.
 *
 * One file per session rather than a single suspended.json: `restore
 * --suspended` writes dozens at once, in parallel, and a shared file would lose
 * entries to its own read-modify-write races. It also lets the placeholder
 * delete its own entry when a human wakes it with Enter, with nothing but `rm`.
 */

/** Token at the head of every placeholder's command line. */
export const PLACEHOLDER_TAG = 'cctabs-suspended'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Everything needed to relaunch a suspended session, and to find its tab. */
export interface SuspendRecord {
  sessionId: string
  /** Tab title and `claude --name`. */
  name: string
  /** Tab id when it was suspended. Tab ids change when Tabby restarts — see matchSuspendedTabs. */
  tabId?: string
  /** Directory Claude resumes in. */
  dir: string
  /** Backend preset / Claude config dir the session belongs to, when not the default. */
  backend?: string
  configDir?: string
  permissionMode?: PermissionMode
  /**
   * Colour to put back when cctabs wakes the tab. Set only when suspending
   * recoloured it (`suspend --color`); absent means "leave the colour alone".
   */
  color?: string | null
  /** ISO timestamp. */
  suspendedAt: string
}

export function suspendedDir(): string {
  return process.env.CCTABS_SUSPENDED_DIR || join(homedir(), '.config', 'cctabs', 'suspended')
}

/**
 * The registry file for a session. Only a UUID is accepted: the id becomes a
 * filename, and a manifest is hand-editable.
 */
export function recordPath(sessionId: string, dir: string = suspendedDir()): string {
  if (!UUID.test(sessionId)) throw new Error(`Not a session id: ${JSON.stringify(sessionId)}`)
  return join(dir, `${sessionId.toLowerCase()}.json`)
}

/** Write (or replace) a record. Atomic — a concurrent reader never sees half a file. */
export function writeRecord(rec: SuspendRecord, dir: string = suspendedDir()): void {
  mkdirSync(dir, { recursive: true })
  const file = recordPath(rec.sessionId, dir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n')
  renameSync(tmp, file)
}

export function removeRecord(sessionId: string, dir: string = suspendedDir()): void {
  try { unlinkSync(recordPath(sessionId, dir)) } catch { /* already gone */ }
}

/** Every record on disk. Unreadable or malformed files are skipped, not fatal. */
export function readRecords(dir: string = suspendedDir()): SuspendRecord[] {
  if (!existsSync(dir)) return []
  const out: SuspendRecord[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const rec = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SuspendRecord
      if (rec && typeof rec.sessionId === 'string' && UUID.test(rec.sessionId) && typeof rec.name === 'string') out.push(rec)
    } catch {
      // A file mid-write by another process, or hand-mangled. Skip.
    }
  }
  return out
}

/**
 * Can this shell run the placeholder? Pure.
 *
 * bash, zsh and the plain sh family only. fish's `read`, `trap` and `VAR=x cmd`
 * are different enough that one script can't serve both, and cmd.exe has no
 * `read` at all — refusing up front beats a placeholder that dies on a parse
 * error while cctabs reports the tab suspended.
 */
export function shellCanHostPlaceholder(shell: TabShell): boolean {
  if (!shell.posix) return false
  const base = (shell.command.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase()
  return ['zsh', 'bash', 'sh', 'dash', 'ksh', 'mksh', 'ash'].includes(base)
}

export interface PlaceholderSpec {
  sessionId: string
  name: string
  dir: string
  /** Env prefix for the Claude launch (backend / config dir). */
  env?: Record<string, string>
  model?: string
  permissionMode?: PermissionMode
  /** `claude.flags` from config, unquoted. */
  extraFlags: string[]
  /** Shown after the name on the marker line, e.g. "2.1MB · ~/Dev/x". */
  detail?: string
  /** Registry file the placeholder deletes when it wakes. */
  recordFile: string
}

/**
 * The `claude` line a woken placeholder runs. Pure.
 *
 * Every value is single-quoted: this is a string the shell parses, and a tab
 * name or config dir with a space or `$` in it must reach Claude intact.
 */
export function placeholderClaudeLine(spec: PlaceholderSpec): string {
  const q = shellQuoteArg
  const env = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${q(v)}`)
  const argv = [
    'claude',
    ...spec.extraFlags.map(q),
    '--resume', spec.sessionId,
    '--name', q(spec.name),
    ...(spec.model ? ['--model', q(spec.model)] : []),
    ...(spec.permissionMode ? ['--permission-mode', spec.permissionMode] : []),
  ]
  return [...env, ...argv].join(' ')
}

/**
 * The placeholder's shell body. Pure.
 *
 * Shape, and why each part is there:
 *
 *   - `true cctabs-suspended <id>` first, so the tag and session id are at the
 *     head of the process's argv — signal 1 in the header comment.
 *   - A clear of the visible screen, the marker and a hint, then `read`. Any line of input wakes it: Enter
 *     from a human, or the nonce `cctabs wake`/`send` types, which the wake
 *     line echoes back so a waker can tell THIS wake's output from anything
 *     older in the buffer.
 *   - `trap 'true' INT` around the read: without a handler, Ctrl-C at the
 *     placeholder aborts the whole `-c` list — including the trailing
 *     `exec $SHELL` — and leaves a dead tab. A handler (not an ignore, which
 *     Claude would inherit across exec) just lets the read return.
 *   - `rm -f <record>` before Claude starts, so a human wake is reflected in
 *     the registry without cctabs being involved.
 *   - Claude runs as a CHILD, not exec'd, and the caller appends
 *     `; exec $SHELL -l -i` (see tabLaunchArgv) — the same shape as every other
 *     cctabs tab, so quitting Claude leaves a shell rather than a dead tab.
 */
export function placeholderBody(spec: PlaceholderSpec): string {
  const q = shellQuoteArg
  const headline = spec.detail ? `${spec.name} · ${spec.detail}` : spec.name
  return [
    `true ${PLACEHOLDER_TAG} ${spec.sessionId}`,
    // Clear the visible screen (not the scrollback): a placeholder typed into
    // an existing shell otherwise sits under a screenful of its own echo.
    `printf '\\033[H\\033[2J'`,
    `printf ${q(`\\n  ${SUSPEND_MARKER} — %s\\n    press Enter to resume\\n`)} ${q(headline)}`,
    `trap 'true' INT`,
    `read cctabs_wake`,
    `trap - INT`,
    `rm -f ${q(spec.recordFile)}`,
    `printf ${q('\\n▶ cctabs: resuming %s (%s)\\n')} ${q(spec.name)} "$cctabs_wake"`,
    `cd ${q(spec.dir)} && ${placeholderClaudeLine(spec)}`,
  ].join('; ')
}

/**
 * What a waker types to wake a placeholder, and the text the placeholder
 * echoes back once it has. Unique per wake, so the "(nonce)" in the echo can
 * only be this wake's.
 */
export function wakeNonce(): string {
  return `w${Math.random().toString(16).slice(2, 10)}`
}

/** Placeholder processes by the session they hold. */
export interface PlaceholderProc {
  pid: number
  /** A Claude is running beneath it: the placeholder has been woken. */
  woken: boolean
}

const PLACEHOLDER_RE = new RegExp(`(?:^|\\s)true ${PLACEHOLDER_TAG} ([0-9a-f-]{36})(?=[;\\s]|$)`, 'i')

/** Find every placeholder in a process table, keyed by session id. Pure. */
export function placeholderSessions(rows: ProcRow[]): Map<string, PlaceholderProc> {
  const out = new Map<string, PlaceholderProc>()
  for (const r of rows) {
    if (isClaudeCommand(r.command)) continue
    const m = PLACEHOLDER_RE.exec(r.command)
    if (!m || !UUID.test(m[1])) continue
    const woken = descendantsOf(r.pid, rows).some((d) => isClaudeCommand(d.command))
    const id = m[1].toLowerCase()
    const prior = out.get(id)
    // Two placeholders on one session: prefer the one still waiting, since
    // that is the one a wake should reach.
    if (!prior || (prior.woken && !woken)) out.set(id, { pid: r.pid, woken })
  }
  return out
}

/** A tab reduced to what suspension matching needs. */
export interface SuspendTab {
  tabId: string
  name: string
  cwd?: string
  /** The tab's shell pid (`stable-pid`), when reported. */
  shellPid?: number
  /** Whether that shell is alive; undefined when the backend can't say. */
  shellAlive?: boolean
  /** A Claude process is matched to this tab. */
  claudeRunning: boolean
}

export interface SuspendedMatch {
  record: SuspendRecord
  /** How the tab was tied to its record. */
  via: 'registry' | 'registry-name' | 'process' | 'marker'
  /**
   * The process table is readable and no placeholder is running for this
   * session: the tab is registered as suspended but holds no process that a
   * keypress could wake (Tabby restarted and hasn't spawned it). Waking it
   * means putting the placeholder back first.
   */
  dormant?: boolean
}

/**
 * Pair each tab with the suspended session it holds, if any. Pure.
 *
 * A tab is tied to a record three ways:
 *
 *   - `registry` — the record's tab id is this tab's. The normal case.
 *   - `process` — this tab's own shell IS a placeholder (stable-pid). Survives
 *     everything short of the placeholder exiting.
 *   - `registry-name` — the record's tab id is gone from the bar entirely and
 *     exactly one tab carries its name. This is what a Tabby restart looks
 *     like: every tab id changes, names don't. Taken only when unique both
 *     ways, like argv-name matching in claude-procs.ts.
 *
 * Then {@link isSuspended} decides from the evidence. `placeholders` is null
 * when there is no process table; `bufferMarker` is only consulted in that
 * case, lazily, because it costs a buffer read per tab.
 */
export function matchSuspendedTabs(
  tabs: SuspendTab[],
  records: SuspendRecord[],
  placeholders: Map<string, PlaceholderProc> | null,
  bufferMarker: (tabId: string) => boolean = () => false,
): Map<string, SuspendedMatch> {
  const out = new Map<string, SuspendedMatch>()
  const present = new Set(tabs.map((t) => t.tabId))
  const nameCount = new Map<string, number>()
  for (const t of tabs) nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1)
  const bySession = new Map(records.map((r) => [r.sessionId.toLowerCase(), r]))
  const usedRecords = new Set<SuspendRecord>()

  const candidates = new Map<string, SuspendedMatch>()
  for (const t of tabs) {
    const byId = records.find((r) => r.tabId === t.tabId)
    if (byId) { candidates.set(t.tabId, { record: byId, via: 'registry' }); usedRecords.add(byId); continue }

    if (t.shellPid && placeholders) {
      const hit = [...placeholders.entries()].find(([, p]) => p.pid === t.shellPid)
      if (hit) {
        const rec = bySession.get(hit[0]) ?? {
          sessionId: hit[0],
          name: t.name,
          dir: t.cwd ?? '',
          suspendedAt: '',
        }
        candidates.set(t.tabId, { record: rec, via: 'process' })
        usedRecords.add(rec)
      }
    }
  }
  for (const t of tabs) {
    if (candidates.has(t.tabId) || nameCount.get(t.name) !== 1) continue
    const drifted = records.filter(
      (r) => r.name === t.name && !usedRecords.has(r) && (!r.tabId || !present.has(r.tabId)),
    )
    if (drifted.length !== 1) continue
    candidates.set(t.tabId, { record: drifted[0], via: 'registry-name' })
    usedRecords.add(drifted[0])
  }

  for (const t of tabs) {
    const c = candidates.get(t.tabId)
    const ph = c && placeholders ? placeholders.get(c.record.sessionId.toLowerCase()) : undefined
    const suspended = isSuspended({
      registered: !!c && c.via !== 'process',
      placeholder: !placeholders ? undefined : !c ? 'absent' : ph ? (ph.woken ? 'woken' : 'waiting') : 'absent',
      claudeRunning: t.claudeRunning,
      shellAlive: t.shellAlive,
      bufferMarker: !placeholders && !c ? bufferMarker(t.tabId) : false,
    })
    if (!suspended) continue
    if (c) {
      out.set(t.tabId, placeholders && !ph ? { ...c, dormant: true } : c)
    } else {
      // Only the on-screen marker says so (no process table, no record): a
      // suspended tab whose session we don't know. Reported, never woken.
      out.set(t.tabId, { record: { sessionId: '', name: t.name, dir: t.cwd ?? '', suspendedAt: '' }, via: 'marker' })
    }
  }
  return out
}
