import { readdirSync, readFileSync, statSync, existsSync, appendFileSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join, basename, extname } from 'path'
import { resolve } from 'path'
import {
  scopeToDirs,
  originOf,
  type ClaudeConfigDir,
  type ConfigDirScope,
  type SessionOrigin,
} from './config-dirs.js'

/** Convert an absolute path to Claude Code's project slug.
 * Claude Code replaces any non-alphanumeric character (spaces, /, ., etc.) with '-'.
 * Hyphens are preserved. Example: "/Users/me/Remember This" → "-Users-me-Remember-This". */
export function pathToProjectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * Has Claude ever held a session in this directory?
 *
 * Answers the only question that makes auto-confirming the folder-trust dialog
 * defensible: a transcript under `<configDir>/projects/<slug>` is evidence that
 * the user has already worked here in a previous session, so the trust decision
 * was made by them, earlier, and we are re-affirming it rather than making it.
 *
 * A directory with no transcripts is genuinely new to Claude, and there the
 * dialog is doing its job — we leave it alone for the human. Searches every
 * config dir, because a second-account session lands under its own root.
 */
export function hasPriorSessions(dir: string, scope?: ConfigDirScope): boolean {
  const slug = pathToProjectSlug(dir)
  for (const cfg of scopeToDirs(scope)) {
    const projectDir = join(cfg.projectsRoot, slug)
    if (!existsSync(projectDir)) continue
    try {
      if (readdirSync(projectDir).some((f) => extname(f) === '.jsonl')) return true
    } catch {
      // Unreadable project dir tells us nothing; keep looking.
    }
  }
  return false
}

/** Find the most recent .jsonl session file in a Claude project directory */
function latestJsonlIn(projectDir: string): string | null {
  if (!existsSync(projectDir)) return null
  const files = readdirSync(projectDir)
    .filter((f) => extname(f) === '.jsonl')
    .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return files.length ? basename(files[0].name, '.jsonl') : null
}

/**
 * Find the most recent Claude Code session ID for a directory.
 * Also checks worktree subdirectories (.claude/worktrees/*) since tabs
 * opened with --worktree run from a worktree path, not the repo root.
 */
export function findLatestSessionId(dir: string, scope?: ConfigDirScope): string | null {
  for (const cfg of scopeToDirs(scope)) {
    const projectsRoot = cfg.projectsRoot

    // 1. Direct match on the given dir
    const direct = latestJsonlIn(join(projectsRoot, pathToProjectSlug(dir)))
    if (direct) return direct

    // 2. Check worktrees under dir: dir/.claude/worktrees/<name>
    const worktreesDir = join(dir, '.claude', 'worktrees')
    if (existsSync(worktreesDir)) {
      const candidates: Array<{ id: string; mtime: number }> = []
      for (const entry of readdirSync(worktreesDir)) {
        const worktreePath = join(worktreesDir, entry)
        const slug = pathToProjectSlug(worktreePath)
        const projectDir = join(projectsRoot, slug)
        const id = latestJsonlIn(projectDir)
        if (id) {
          const mtime = statSync(join(projectDir, id + '.jsonl')).mtimeMs
          candidates.push({ id, mtime })
        }
      }
      if (candidates.length) {
        candidates.sort((a, b) => b.mtime - a.mtime)
        return candidates[0].id
      }
    }
  }

  return null
}

export interface SessionMatch extends SessionOrigin {
  id: string
  mtime: number
  size: number
  firstPrompt: string
  lastActivity: string
}

/**
 * Every transcript in one project directory whose *current* title is `name`,
 * with the context callers display and the cwd it can be resumed from.
 *
 * Shared by the by-directory and the whole-machine lookups below, which used to
 * carry two copies of this parsing (including two copies of the cwd-drift rule).
 */
function scanProjectDirForName(
  projectDir: string,
  name: string,
  origin: SessionOrigin,
): Array<SessionMatch & { cwd: string }> {
  if (!existsSync(projectDir)) return []
  const expectedSlug = basename(projectDir)
  const found: Array<SessionMatch & { cwd: string }> = []

  for (const f of readdirSync(projectDir)) {
    if (extname(f) !== '.jsonl') continue
    const fullPath = join(projectDir, f)
    try {
      const lines = readFileSync(fullPath, 'utf-8').split('\n')

      // Find the LAST customTitle entry — sessions can be renamed, and only
      // the most recent title is the current one
      let currentTitle = ''
      let cwd = ''
      let firstPrompt = ''
      let lastActivity = ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.customTitle !== undefined) currentTitle = entry.customTitle
          // Last wins, but only among cwd values that actually belong to THIS
          // file's storage location (slug match). A session's cwd can change
          // mid-life because it was genuinely relaunched elsewhere — the
          // transcript moves with it — or because the agent ran `cd <subdir>`
          // via the Bash tool, which drifts the per-message cwd while the
          // transcript stays put. Resuming into a drifted directory fails with
          // "No conversation found", so only a slug-matching cwd is accepted.
          if (typeof entry.cwd === 'string' && pathToProjectSlug(entry.cwd) === expectedSlug) {
            cwd = entry.cwd
          }
          // First user message
          if (!firstPrompt && entry.type === 'user' && entry.message?.content) {
            const text = typeof entry.message.content === 'string'
              ? entry.message.content
              : entry.message.content.find((c: { type: string }) => c.type === 'text')?.text ?? ''
            // Skip system/command messages
            if (text.startsWith('<')) continue
            firstPrompt = text.slice(0, 120).replace(/\n/g, ' ').trim()
            if (text.length > 120) firstPrompt += '…'
          }
          // Track last assistant text for context
          if (entry.message?.role === 'assistant' && entry.message?.content) {
            const parts = Array.isArray(entry.message.content) ? entry.message.content : [{ type: 'text', text: entry.message.content }]
            for (const p of parts) {
              if (p.type === 'text' && p.text?.trim()) {
                lastActivity = p.text.slice(0, 120).replace(/\n/g, ' ').trim()
                if (p.text.length > 120) lastActivity += '…'
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }

      if (currentTitle !== name) continue

      const stat = statSync(fullPath)
      found.push({
        id: basename(f, '.jsonl'),
        mtime: stat.mtimeMs,
        size: stat.size,
        firstPrompt,
        lastActivity,
        cwd,
        ...origin,
      })
    } catch {
      // skip unreadable files
    }
  }

  return found
}

/**
 * Find all sessions with a given custom title (--name) under `dir`, across every
 * Claude config dir. Newest first, with the first user prompt for context.
 */
export function findSessionsByName(dir: string, name: string, scope?: ConfigDirScope): SessionMatch[] {
  const matches: SessionMatch[] = []
  for (const cfg of scopeToDirs(scope)) {
    const projectDir = join(cfg.projectsRoot, pathToProjectSlug(dir))
    matches.push(...scanProjectDirForName(projectDir, name, originOf(cfg)))
  }
  // Newest first, across config dirs too — the same rule already used to pick
  // between same-named sessions in different projects.
  return matches.sort((a, b) => b.mtime - a.mtime)
}

interface TitleEntry { id: string; cwd: string; mtime: number }

/**
 * Per-project-dir cache of `customTitle → newest session`. Built once per
 * project directory and reused, so callers that resolve many tabs (e.g.
 * `cctabs sessions --json` over 40+ tabs sharing one repo's project dir)
 * scan each directory a single time instead of once per tab.
 *
 * Cleared implicitly per process — cctabs commands are one-shot, so a stale
 * cache is never a concern within a single invocation.
 */
const titleIndexCache = new Map<string, Map<string, TitleEntry>>()

function buildTitleIndex(projectDir: string): Map<string, TitleEntry> {
  const cached = titleIndexCache.get(projectDir)
  if (cached) return cached

  const index = new Map<string, TitleEntry>()
  if (!existsSync(projectDir)) {
    titleIndexCache.set(projectDir, index)
    return index
  }

  // The slug this directory corresponds to — used below to filter out cwd
  // values that don't actually belong to this file's storage location (see
  // the note near the backward cwd scan).
  const expectedSlug = basename(projectDir)

  for (const f of readdirSync(projectDir)) {
    if (extname(f) !== '.jsonl') continue
    const full = join(projectDir, f)
    let title = ''
    let cwd = ''
    try {
      const content = readFileSync(full, 'utf-8')
      const lines = content.split('\n')

      // Cheap pre-filter: only the rare line carrying a customTitle is worth
      // JSON.parse-ing here. Most lines are message content — skipping them
      // is what keeps a 40-tab `sessions --json` from taking minutes.
      for (const line of lines) {
        if (!line.includes('"customTitle"')) continue
        try {
          const e = JSON.parse(line)
          if (e.customTitle !== undefined) title = e.customTitle // last wins (renames)
        } catch { /* skip malformed line */ }
      }

      // cwd can change mid-session in two different ways, and only one of
      // them is safe to resume into: (a) the session was actually relaunched
      // from a new directory (e.g. a worktree got deleted and it was later
      // resumed from the repo root) — the transcript itself lives at that
      // new location, so relaunching there is correct; (b) the agent just
      // ran `cd <subdir>` via the Bash tool mid-session — Claude Code's
      // per-message cwd tracks that logical drift, but the transcript file
      // never moves, so relaunching from the drifted directory 404s with
      // "No conversation found". The two are indistinguishable by cwd value
      // alone, so only accept a recorded cwd whose own project slug matches
      // the directory this file physically lives in — that's guaranteed
      // resumable; anything else is Bash-drift and gets skipped in favor of
      // an earlier, matching entry. Scan from the end so the common case
      // (no drift) still costs one parse, not a full-file scan.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line || !line.includes('"cwd"')) continue
        try {
          const e = JSON.parse(line)
          if (typeof e.cwd === 'string' && pathToProjectSlug(e.cwd) === expectedSlug) {
            cwd = e.cwd
            break
          }
        } catch { /* try an earlier line */ }
      }
    } catch { continue }

    if (!title) continue
    let mtime = 0
    try { mtime = statSync(full).mtimeMs } catch { /* keep 0 */ }
    const id = basename(f, '.jsonl')
    const prev = index.get(title)
    if (!prev || mtime > prev.mtime) index.set(title, { id, cwd, mtime })
  }

  titleIndexCache.set(projectDir, index)
  return index
}

/**
 * Resolve the Claude session a *tab* is running, given the tab's shell cwd and
 * its name. Crucially worktree-aware: a tab opened with `--worktree <name>`
 * keeps its shell cwd at the repo root, but Claude runs inside
 * `<repo>/.claude/worktrees/<name>` — so its session lives under that
 * worktree's project slug, NOT the repo-root slug. Resolving by the repo-root
 * cwd alone (as a naive name lookup does) finds an older same-named session in
 * the repo root, or nothing — the exact bug that made restore resume the wrong
 * conversation for worktree tabs.
 *
 * Returns the matched session id AND the directory Claude must be launched from
 * to resume it (the worktree path for worktree tabs), or null if none matches.
 */
export function resolveTabSession(
  cwd: string,
  name: string,
  scope?: ConfigDirScope,
): (SessionOrigin & { id: string; dir: string }) | null {
  // The worktree paths to consider, alongside the tab's own cwd. Same list for
  // every config dir — worktrees are a property of the repo, not the account.
  const worktreePaths: string[] = []
  const worktreesDir = join(cwd, '.claude', 'worktrees')
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir)) worktreePaths.push(join(worktreesDir, entry))
  }

  let best: (SessionOrigin & { id: string; dir: string; mtime: number }) | null = null

  for (const cfg of scopeToDirs(scope)) {
    const { projectsRoot } = cfg
    const origin = originOf(cfg)

    // 1. Strongest signal: a worktree named exactly after the tab. A
    //    `--worktree <name>` launch lands at .claude/worktrees/<name>, so a
    //    name-matched session there is definitively this tab's — prefer it even
    //    if a stale repo-root session of the same name has a newer mtime.
    const namedWtPath = join(cwd, '.claude', 'worktrees', name)
    const namedHit = buildTitleIndex(join(projectsRoot, pathToProjectSlug(namedWtPath))).get(name)
    if (namedHit) return { id: namedHit.id, dir: namedHit.cwd || namedWtPath, ...origin }

    // 2. Otherwise: newest name-match across the cwd's own project dir and any
    //    worktree project dirs under it — and, now, across config dirs, which
    //    is the same newest-wins rule applied one level up.
    const candidates = [join(projectsRoot, pathToProjectSlug(cwd))]
    for (const wt of worktreePaths) candidates.push(join(projectsRoot, pathToProjectSlug(wt)))

    for (const projectDir of candidates) {
      const hit = buildTitleIndex(projectDir).get(name)
      if (hit && (!best || hit.mtime > best.mtime)) {
        best = { id: hit.id, dir: hit.cwd || cwd, mtime: hit.mtime, ...origin }
      }
    }
  }

  if (!best) return null
  const { mtime: _mtime, ...result } = best
  return result
}

/**
 * Like findSessionsByName, but searches every project directory in every Claude
 * config dir. Each match carries the cwd recorded in the session and where it
 * was found. Used by `cctabs restore` so callers don't have to guess the right
 * directory — or the right Claude account.
 */
export function findSessionsByNameGlobally(
  name: string,
  scope?: ConfigDirScope,
): Array<SessionMatch & { dir: string }> {
  const matches: Array<SessionMatch & { dir: string }> = []

  for (const cfg of scopeToDirs(scope)) {
    const { projectsRoot } = cfg
    if (!existsSync(projectsRoot)) continue
    const origin = originOf(cfg)

    for (const slug of readdirSync(projectsRoot)) {
      const projectDir = join(projectsRoot, slug)
      let isDir = false
      try { isDir = statSync(projectDir).isDirectory() } catch { continue }
      if (!isDir) continue

      for (const hit of scanProjectDirForName(projectDir, name, origin)) {
        // Without a resumable cwd there is nowhere to relaunch this session.
        if (!hit.cwd) continue
        matches.push({ ...hit, dir: hit.cwd })
      }
    }
  }

  return matches.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Locate the on-disk .jsonl for a session id. `dirs` are the directories whose
 * project slugs to check, in priority order — typically the launch dir that
 * resolveTabSession returned (the worktree path for a worktree tab, so this
 * finds the session under the worktree slug rather than the repo-root slug) plus
 * the tab's shell cwd as a fallback. Deriving the slug from the dir means this
 * works even when the physical worktree has since been deleted. Returns the
 * absolute file path, or null if no candidate exists.
 */
export function findSessionFileById(
  sessionId: string,
  dirs: string[],
  scope?: ConfigDirScope,
): string | null {
  for (const cfg of scopeToDirs(scope)) {
    for (const d of dirs) {
      if (!d) continue
      const file = join(cfg.projectsRoot, pathToProjectSlug(d), `${sessionId}.jsonl`)
      if (existsSync(file)) return file
    }
  }
  return null
}

/** True if `file` is empty or ends with a newline — i.e. appending a fresh line
 * won't glue onto a partial last line (a jsonl always ends with \n, but a crash
 * mid-write could leave one dangling). */
function endsWithNewline(file: string): boolean {
  const size = statSync(file).size
  if (size === 0) return true
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    readSync(fd, buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

/**
 * Persist a new title for a session by appending a `custom-title` entry to its
 * .jsonl — the SAME line shape Claude Code writes when launched with `--name`.
 * cctabs' name resolution reads the LAST customTitle, so after this
 * `cctabs resume <newTitle>` finds the session.
 *
 * This exists because neither Claude's in-session `/rename` nor a bare terminal
 * tab-title change touches disk — both only relabel the ephemeral tab / live RC
 * session — so a rename is otherwise invisible to resume-by-name. Append-only;
 * never rewrites existing lines.
 */
export function persistSessionTitle(file: string, sessionId: string, newTitle: string): void {
  const line = JSON.stringify({ type: 'custom-title', customTitle: newTitle, sessionId })
  const prefix = endsWithNewline(file) ? '' : '\n'
  appendFileSync(file, `${prefix}${line}\n`)
}

/**
 * Single-pass scan of every ~/.claude/projects/*\/*.jsonl: for each session,
 * return its current customTitle (the LAST one in the file — sessions can be
 * renamed) and its mtime. Used by `cctabs sort` to score tab activity.
 *
 * Returns Map<customTitle, latestMtimeMs>: when a title appears in multiple
 * sessions (forks, restarts), we keep the most recent mtime.
 */
export function buildTitleActivityMap(scope?: ConfigDirScope): Map<string, number> {
  const result = new Map<string, number>()
  for (const cfg of scopeToDirs(scope)) {
    collectTitleActivity(cfg.projectsRoot, result)
  }
  return result
}

function collectTitleActivity(projectsRoot: string, result: Map<string, number>): void {
  if (!existsSync(projectsRoot)) return

  for (const slug of readdirSync(projectsRoot)) {
    const projectDir = join(projectsRoot, slug)
    let isDir = false
    try { isDir = statSync(projectDir).isDirectory() } catch { continue }
    if (!isDir) continue

    for (const f of readdirSync(projectDir)) {
      if (extname(f) !== '.jsonl') continue
      const fullPath = join(projectDir, f)
      try {
        const mtime = statSync(fullPath).mtimeMs
        // Find the last customTitle by reading the file line-by-line.
        // We can't shortcut by reading only the first line — sessions can be
        // renamed mid-flight and the later entry wins.
        const content = readFileSync(fullPath, 'utf-8')
        let currentTitle = ''
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.customTitle !== undefined) currentTitle = entry.customTitle
          } catch { /* skip malformed lines */ }
        }
        if (!currentTitle) continue
        const prev = result.get(currentTitle) ?? 0
        if (mtime > prev) result.set(currentTitle, mtime)
      } catch { /* skip unreadable files */ }
    }
  }
}

/**
 * List all unique session names (customTitle) in a project directory, across
 * every Claude config dir. Used to show available names when a resume lookup
 * fails — a hint that omitted another account's sessions would send the user
 * looking for a name that is right there.
 */
export function listSessionNames(
  dir: string,
  scope?: ConfigDirScope,
): Array<{ name: string; id: string; mtime: number; backend?: string }> {
  const results: Array<{ name: string; id: string; mtime: number; backend?: string }> = []
  const seen = new Set<string>()

  for (const cfg of scopeToDirs(scope)) {
  const projectDir = join(cfg.projectsRoot, pathToProjectSlug(dir))
  if (!existsSync(projectDir)) continue
  const { backend } = originOf(cfg)
  const files = readdirSync(projectDir).filter((f) => extname(f) === '.jsonl')

  for (const f of files) {
    const fullPath = join(projectDir, f)
    try {
      // Read only the first line — customTitle is always the first entry
      const content = readFileSync(fullPath, 'utf-8')
      const firstLine = content.split('\n')[0]
      if (!firstLine) continue

      const entry = JSON.parse(firstLine)
      const title = entry.customTitle
      if (!title || seen.has(title)) continue
      seen.add(title)

      const stat = statSync(fullPath)
      results.push({ name: title, id: basename(f, '.jsonl'), mtime: stat.mtimeMs, backend })
    } catch {
      // skip unreadable files
    }
  }
  }

  return results.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Resolve a session ID prefix (e.g. "19aae7b4") to the full UUID by scanning
 * `~/.claude/projects/`. Returns the input unchanged if it already looks like
 * a full UUID, or null if no unique match exists. Pass `dir` to scope the
 * search to one project; otherwise every project is checked.
 *
 * `claude --resume <prefix>` does NOT accept truncated IDs — it treats them
 * as a search query and shows the picker. So callers must expand prefixes
 * before forwarding to claude.
 */
export function expandSessionId(input: string, dir?: string, scope?: ConfigDirScope): string | null {
  if (!input) return null
  // Already a full UUID — pass through unchanged, without paying for a scan.
  if (isFullSessionId(input)) return input
  return locateSessionById(input, dir, scope)?.id ?? null
}

function isFullSessionId(input: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)
}

/**
 * Locate a session by id (full or prefix) and report WHERE it lives.
 *
 * The location is the point: a manifest can carry a session id without saying
 * which Claude account it belongs to, and resuming that id under the wrong
 * config dir doesn't fail — Claude just can't find the conversation and starts
 * a fresh one. Finding the transcript tells us the config dir, which tells us
 * the backend, so an id alone is enough to relaunch correctly.
 *
 * Returns null when the id matches nothing, or matches more than one session
 * (an ambiguous prefix). Scans filenames only — no transcript parsing.
 */
export function locateSessionById(
  input: string,
  dir?: string,
  scope?: ConfigDirScope,
): (SessionOrigin & { id: string }) | null {
  if (!input) return null

  const matches: Array<SessionOrigin & { id: string }> = []

  for (const cfg of scopeToDirs(scope)) {
    const { projectsRoot } = cfg
    if (!existsSync(projectsRoot)) continue
    const origin = originOf(cfg)

    const projectDirs = dir
      ? [join(projectsRoot, pathToProjectSlug(dir))]
      : readdirSync(projectsRoot)
          .map((d) => join(projectsRoot, d))
          .filter((p) => {
            try { return statSync(p).isDirectory() } catch { return false }
          })

    for (const pd of projectDirs) {
      if (!existsSync(pd)) continue
      for (const f of readdirSync(pd)) {
        if (extname(f) !== '.jsonl') continue
        const id = basename(f, '.jsonl')
        if (!id.startsWith(input)) continue
        if (matches.some((m) => m.id === id && m.configDir === origin.configDir)) continue
        matches.push({ id, ...origin })
      }
    }
  }

  if (matches.length === 1) return matches[0]
  // The same id in two config dirs is a copied transcript, not an ambiguous
  // prefix — the id is unambiguous, only its home isn't. Prefer the default
  // config dir, which is where an unqualified id would have been looked up all
  // along.
  const sameId = matches.every((m) => m.id === matches[0]?.id)
  if (matches.length > 1 && sameId) {
    return matches.find((m) => !m.configDir) ?? matches[0]
  }
  return null
}

/**
 * Find the most recently created session ID after a given timestamp.
 * Used by `cctabs fork` to detect the session Claude created in response to /branch.
 */
export function findNewestSessionIdSince(
  dir: string,
  sinceMs: number,
  scope?: ConfigDirScope,
): string | null {
  const candidates: Array<{ id: string; mtime: number }> = []

  function scanProjectDir(projectDir: string) {
    if (!existsSync(projectDir)) return
    for (const f of readdirSync(projectDir)) {
      if (extname(f) !== '.jsonl') continue
      const mtime = statSync(join(projectDir, f)).mtimeMs
      if (mtime > sinceMs) {
        candidates.push({ id: basename(f, '.jsonl'), mtime })
      }
    }
  }

  for (const cfg of scopeToDirs(scope)) {
    // Scan direct project dir
    scanProjectDir(join(cfg.projectsRoot, pathToProjectSlug(dir)))

    // Scan worktrees under dir
    const worktreesDir = join(dir, '.claude', 'worktrees')
    if (existsSync(worktreesDir)) {
      for (const entry of readdirSync(worktreesDir)) {
        scanProjectDir(join(cfg.projectsRoot, pathToProjectSlug(join(worktreesDir, entry))))
      }
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].id
}
