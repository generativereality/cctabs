import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
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
