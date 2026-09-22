import type { SessionRow } from './session-rows.js'

/**
 * `cctabs manifest`: turn the live session list into a restore manifest that is
 * safe to act on.
 *
 * Every rule here is a correction a hand-built fleet manifest needed, each of
 * which cost a measurement to find:
 *
 *   - **The calling session is excluded.** It cannot restart itself, and a
 *     restart that kills its own driver stops halfway. Matched by session id
 *     and by pid, never by tab — tab identity is the thing that fails on a
 *     stock Tabby (see the `stable-pid` capability).
 *   - **Keyed on session id, never on name.** One session carried two names —
 *     the tab's and a stale spawn-time `--name` — was listed twice, and restore
 *     spawned a second Claude onto a live `.jsonl`. So two entries resolving to
 *     one id are a collision: resolved only when a live process proves which tab
 *     owns the session, an error otherwise.
 *   - **Every dir must exist.** Restoring into a deleted worktree gives a Claude
 *     whose `Skill()` answers `Unknown skill` and whose `git` fails with
 *     `Unable to read current working directory`.
 *   - **Every session id must have a transcript** in some config dir, or
 *     `--resume` quietly opens a fresh conversation.
 *
 * Pure: the filesystem checks are injected.
 */

/** One manifest entry — exactly the shape `restore --manifest` reads. */
export interface ManifestEntry {
  name: string
  dir: string
  session_id?: string
  backend?: string
  config_dir?: string
  permission_mode?: string
  color?: string | null
}

export type ProblemCode =
  /** The entry's directory is gone. */
  | 'missing-dir'
  /** The directory was gone and has been pointed at the fallback. */
  | 'repointed'
  /** The id has no transcript in any config dir. */
  | 'no-transcript'
  /** Two or more entries resolve to one session, and nothing says which owns it. */
  | 'duplicate-session'
  /** A collision settled by a live process — the losers are dropped. */
  | 'duplicate-session-dropped'
  /** No session could be resolved; restoring it starts a fresh Claude. */
  | 'no-session'
  /** Two tabs share a name, which restore cannot tell apart. */
  | 'duplicate-name'

export interface ManifestProblem {
  name: string
  severity: 'error' | 'warning'
  code: ProblemCode
  message: string
}

export interface ManifestResult {
  entries: ManifestEntry[]
  /** Rows left out on purpose (the calling session), with why. */
  excluded: Array<{ name: string; reason: string }>
  problems: ManifestProblem[]
}

export interface ManifestOptions {
  /** CLAUDE_CODE_SESSION_ID of the caller. */
  selfSessionId?: string
  /** Pid of the Claude the caller runs under. */
  selfClaudePid?: number
  /** Keep the calling session in (only for a manifest that won't drive a restart). */
  includeSelf?: boolean
  /** Point entries whose dir is gone here instead of failing. */
  repointMissingDirs?: string
  dirExists(path: string): boolean
  transcriptExists(sessionId: string): boolean
  /** Session id → pids of live Claude processes launched on it. */
  liveSessionPids: Map<string, number[]>
}

export function buildManifest(rows: SessionRow[], opts: ManifestOptions): ManifestResult {
  const excluded: ManifestResult['excluded'] = []
  const problems: ManifestProblem[] = []

  // -- the caller --
  const kept: SessionRow[] = []
  for (const r of rows) {
    const isSelf =
      (!!opts.selfSessionId && r.session_id === opts.selfSessionId) ||
      (opts.selfClaudePid !== undefined && r.claude_pid === opts.selfClaudePid)
    if (isSelf && !opts.includeSelf) {
      excluded.push({ name: r.name, reason: 'the calling session — it cannot restart itself' })
      continue
    }
    kept.push(r)
  }

  // -- one session, one entry --
  const byId = new Map<string, SessionRow[]>()
  for (const r of kept) {
    if (!r.session_id) continue
    const list = byId.get(r.session_id)
    if (list) list.push(r)
    else byId.set(r.session_id, [r])
  }
  const dropped = new Set<SessionRow>()
  const collided = new Set<SessionRow>()
  for (const [id, group] of byId) {
    if (group.length < 2) continue
    const names = group.map((r) => `"${r.name}"`).join(', ')
    const live = opts.liveSessionPids.get(id) ?? []
    // A tab whose own Claude was launched on this id owns it. Anything else
    // that resolved to it is a stale title match (a leftover tab carrying the
    // session's old name) and must not be restored onto a live session.
    const owners = group.filter((r) => r.claude_pid !== undefined && live.includes(r.claude_pid))
    if (owners.length === 1) {
      for (const r of group) {
        if (r === owners[0]) continue
        dropped.add(r)
        problems.push({
          name: r.name,
          severity: 'warning',
          code: 'duplicate-session-dropped',
          message: `resolves to session ${id.slice(0, 8)}…, which "${owners[0].name}" is running — left out, so restore cannot spawn a second Claude onto it`,
        })
      }
      continue
    }
    for (const r of group) {
      collided.add(r)
      problems.push({
        name: r.name,
        severity: 'error',
        code: 'duplicate-session',
        message: `${names} all resolve to session ${id.slice(0, 8)}… and no live process says which owns it — restoring more than one puts two Claudes on one transcript`,
      })
    }
  }

  // -- names restore can't tell apart --
  const nameCount = new Map<string, number>()
  for (const r of kept) if (!dropped.has(r)) nameCount.set(r.name, (nameCount.get(r.name) ?? 0) + 1)

  const entries: ManifestEntry[] = []
  for (const r of kept) {
    if (dropped.has(r)) continue

    if ((nameCount.get(r.name) ?? 0) > 1) {
      problems.push({
        name: r.name,
        severity: 'warning',
        code: 'duplicate-name',
        message: 'more than one tab has this name; restore will report it as ambiguous and leave it alone',
      })
    }

    let dir = r.cwd
    if (!dir || !opts.dirExists(dir)) {
      if (opts.repointMissingDirs) {
        problems.push({
          name: r.name,
          severity: 'warning',
          code: 'repointed',
          message: `${dir || '(no directory)'} is gone — pointed at ${opts.repointMissingDirs}`,
        })
        dir = opts.repointMissingDirs
      } else {
        problems.push({
          name: r.name,
          severity: 'error',
          code: 'missing-dir',
          message: `${dir || '(no directory)'} does not exist — a Claude restored there cannot load skills or run git. Pass --repoint-missing-dirs <dir> or recreate it`,
        })
      }
    }

    if (r.session_id && !opts.transcriptExists(r.session_id)) {
      problems.push({
        name: r.name,
        severity: 'error',
        code: 'no-transcript',
        message: `session ${r.session_id.slice(0, 8)}… has no transcript in any Claude config dir — resuming it would open a fresh conversation`,
      })
    }

    if (!r.session_id && !collided.has(r)) {
      problems.push({
        name: r.name,
        severity: 'warning',
        code: 'no-session',
        message: `no session resolved (${r.session_lookup}) — restoring it starts a fresh Claude, so its context cannot come back`,
      })
    }

    entries.push({
      name: r.name,
      dir,
      ...(r.session_id ? { session_id: r.session_id } : {}),
      ...(r.backend ? { backend: r.backend } : {}),
      ...(r.config_dir ? { config_dir: r.config_dir } : {}),
      ...(r.permission_mode ? { permission_mode: r.permission_mode } : {}),
      ...(r.color !== undefined ? { color: r.color } : {}),
    })
  }

  return { entries, excluded, problems }
}

/** Drop every entry that has an error against it. */
export function withoutInvalid(result: ManifestResult): ManifestEntry[] {
  const bad = new Set(result.problems.filter((p) => p.severity === 'error').map((p) => p.name))
  return result.entries.filter((e) => !bad.has(e.name))
}
