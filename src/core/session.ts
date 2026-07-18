import { readdirSync, readFileSync, statSync, existsSync, appendFileSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join, basename, extname } from 'path'
import { resolve } from 'path'

/** Convert an absolute path to Claude Code's project slug.
 * Claude Code replaces any non-alphanumeric character (spaces, /, ., etc.) with '-'.
 * Hyphens are preserved. Example: "/Users/me/Remember This" → "-Users-me-Remember-This". */
export function pathToProjectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
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
export function findLatestSessionId(dir: string): string | null {
  const projectsRoot = join(homedir(), '.claude', 'projects')

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

  return null
}

export interface SessionMatch {
  id: string
  mtime: number
  size: number
  firstPrompt: string
  lastActivity: string
}

/**
 * Find all sessions with a given custom title (--name).
 * Returns them sorted by most recent first, with the first user prompt for context.
 */
export function findSessionsByName(dir: string, name: string): SessionMatch[] {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const projectDir = join(projectsRoot, pathToProjectSlug(dir))
  if (!existsSync(projectDir)) return []

  const matches: SessionMatch[] = []
  const files = readdirSync(projectDir).filter((f) => extname(f) === '.jsonl')

  for (const f of files) {
    const fullPath = join(projectDir, f)
    try {
      const content = readFileSync(fullPath, 'utf-8')
      const lines = content.split('\n')

      // Find the LAST customTitle entry — sessions can be renamed, and only
      // the most recent title is the current one
      let currentTitle = ''
      let firstPrompt = ''
      let lastActivity = ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.customTitle !== undefined) {
            currentTitle = entry.customTitle
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
      matches.push({ id: basename(f, '.jsonl'), mtime: stat.mtimeMs, size: stat.size, firstPrompt, lastActivity })
    } catch {
      // skip unreadable files
    }
  }

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

      // cwd can change mid-session — e.g. a worktree gets deleted and the
      // session is later resumed from the repo root instead — so the most
      // recent cwd is where it must be relaunched from, not wherever it
      // happened to start. cwd appears on nearly every line (unlike
      // customTitle), so scan from the end and stop at the first hit: that
      // finds the LAST occurrence while still parsing only one line.
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line || !line.includes('"cwd"')) continue
        try {
          const e = JSON.parse(line)
          if (typeof e.cwd === 'string') { cwd = e.cwd; break }
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
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): { id: string; dir: string } | null {
  // 1. Strongest signal: a worktree named exactly after the tab. A
  //    `--worktree <name>` launch lands at .claude/worktrees/<name>, so a
  //    name-matched session there is definitively this tab's — prefer it even
  //    if a stale repo-root session of the same name has a newer mtime.
  const namedWtPath = join(cwd, '.claude', 'worktrees', name)
  const namedHit = buildTitleIndex(join(projectsRoot, pathToProjectSlug(namedWtPath))).get(name)
  if (namedHit) return { id: namedHit.id, dir: namedHit.cwd || namedWtPath }

  // 2. Otherwise: newest name-match across the cwd's own project dir and any
  //    other worktree project dirs under it.
  const candidates = [join(projectsRoot, pathToProjectSlug(cwd))]
  const worktreesDir = join(cwd, '.claude', 'worktrees')
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir)) {
      candidates.push(join(projectsRoot, pathToProjectSlug(join(worktreesDir, entry))))
    }
  }

  let best: { id: string; dir: string; mtime: number } | null = null
  for (const projectDir of candidates) {
    const hit = buildTitleIndex(projectDir).get(name)
    if (hit && (!best || hit.mtime > best.mtime)) {
      best = { id: hit.id, dir: hit.cwd || cwd, mtime: hit.mtime }
    }
  }
  return best ? { id: best.id, dir: best.dir } : null
}

/**
 * Like findSessionsByName, but searches every project directory under
 * ~/.claude/projects. Each match carries the cwd recorded in the session.
 * Used by `cctabs restore` so callers don't have to guess the right dir.
 */
export function findSessionsByNameGlobally(
  name: string,
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): Array<SessionMatch & { dir: string }> {
  if (!existsSync(projectsRoot)) return []

  const matches: Array<SessionMatch & { dir: string }> = []

  for (const slug of readdirSync(projectsRoot)) {
    const projectDir = join(projectsRoot, slug)
    let isDir = false
    try { isDir = statSync(projectDir).isDirectory() } catch { continue }
    if (!isDir) continue

    const files = readdirSync(projectDir).filter((f) => extname(f) === '.jsonl')
    for (const f of files) {
      const fullPath = join(projectDir, f)
      try {
        const content = readFileSync(fullPath, 'utf-8')
        const lines = content.split('\n')

        let currentTitle = ''
        let cwd = ''
        let firstPrompt = ''
        let lastActivity = ''

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.customTitle !== undefined) currentTitle = entry.customTitle
            // Last wins, not first: a session's cwd can change mid-life (e.g.
            // a worktree gets deleted and the session is later resumed from
            // the repo root instead) — the most recent cwd is where it must
            // be relaunched from, not wherever it happened to start.
            if (typeof entry.cwd === 'string') cwd = entry.cwd
            if (!firstPrompt && entry.type === 'user' && entry.message?.content) {
              const text = typeof entry.message.content === 'string'
                ? entry.message.content
                : entry.message.content.find((c: { type: string }) => c.type === 'text')?.text ?? ''
              if (text.startsWith('<')) continue
              firstPrompt = text.slice(0, 120).replace(/\n/g, ' ').trim()
              if (text.length > 120) firstPrompt += '…'
            }
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

        if (currentTitle !== name || !cwd) continue

        const stat = statSync(fullPath)
        matches.push({ id: basename(f, '.jsonl'), mtime: stat.mtimeMs, size: stat.size, firstPrompt, lastActivity, dir: cwd })
      } catch {
        // skip unreadable files
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
  projectsRoot: string = join(homedir(), '.claude', 'projects'),
): string | null {
  for (const d of dirs) {
    if (!d) continue
    const file = join(projectsRoot, pathToProjectSlug(d), `${sessionId}.jsonl`)
    if (existsSync(file)) return file
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
export function buildTitleActivityMap(): Map<string, number> {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const result = new Map<string, number>()
  if (!existsSync(projectsRoot)) return result

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

  return result
}

/**
 * List all unique session names (customTitle) in a project directory.
 * Used to show available names when a resume lookup fails.
 */
export function listSessionNames(dir: string): Array<{ name: string; id: string; mtime: number }> {
  const projectsRoot = join(homedir(), '.claude', 'projects')
  const projectDir = join(projectsRoot, pathToProjectSlug(dir))
  if (!existsSync(projectDir)) return []

  const results: Array<{ name: string; id: string; mtime: number }> = []
  const seen = new Set<string>()
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
      results.push({ name: title, id: basename(f, '.jsonl'), mtime: stat.mtimeMs })
    } catch {
      // skip unreadable files
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
export function expandSessionId(input: string, dir?: string): string | null {
  if (!input) return null
  // Already a full UUID — pass through unchanged.
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input)) {
    return input
  }

  const projectsRoot = join(homedir(), '.claude', 'projects')
  if (!existsSync(projectsRoot)) return null

  const projectDirs = dir
    ? [join(projectsRoot, pathToProjectSlug(dir))]
    : readdirSync(projectsRoot)
        .map((d) => join(projectsRoot, d))
        .filter((p) => {
          try { return statSync(p).isDirectory() } catch { return false }
        })

  const matches: string[] = []
  for (const pd of projectDirs) {
    if (!existsSync(pd)) continue
    for (const f of readdirSync(pd)) {
      if (extname(f) !== '.jsonl') continue
      const id = basename(f, '.jsonl')
      if (id.startsWith(input) && !matches.includes(id)) matches.push(id)
    }
  }
  return matches.length === 1 ? matches[0] : null
}

/**
 * Find the most recently created session ID after a given timestamp.
 * Used by `cctabs fork` to detect the session Claude created in response to /branch.
 */
export function findNewestSessionIdSince(
  dir: string,
  sinceMs: number,
): string | null {
  const projectsRoot = join(homedir(), '.claude', 'projects')

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

  // Scan direct project dir
  scanProjectDir(join(projectsRoot, pathToProjectSlug(dir)))

  // Scan worktrees under dir
  const worktreesDir = join(dir, '.claude', 'worktrees')
  if (existsSync(worktreesDir)) {
    for (const entry of readdirSync(worktreesDir)) {
      scanProjectDir(join(projectsRoot, pathToProjectSlug(join(worktreesDir, entry))))
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => b.mtime - a.mtime)
  return candidates[0].id
}
