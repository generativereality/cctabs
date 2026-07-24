import { resolve } from 'path'
import { homedir } from 'os'
import type { RestoreEntry } from './restore-plan.js'

/**
 * Parse a restore manifest into entries.
 *
 * Deliberately permissive about the wrapper shape so the obvious things a user
 * would pipe in all work without reshaping:
 *
 *   1. A plain array of entries:      `[{name, dir, session_id?}, …]`
 *   2. An object with a sessions key: `{sessions: [...]}`
 *   3. `cctabs sessions --json`:      `{workspaces: [{sessions: [...]}, …]}`
 *
 * Per entry, `dir` and `cwd` are interchangeable; `~` is expanded and the path
 * made absolute. Entries missing a name or directory are skipped rather than
 * failing the whole file — a manifest is often hand-edited.
 */
export function parseManifest(raw: string): RestoreEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${(err as Error).message}`)
  }

  const collected: unknown[] = []
  if (Array.isArray(parsed)) {
    collected.push(...parsed)
  } else if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    if (Array.isArray(p.sessions)) {
      collected.push(...p.sessions)
    }
    if (Array.isArray(p.workspaces)) {
      for (const ws of p.workspaces) {
        if (ws && typeof ws === 'object' && Array.isArray((ws as Record<string, unknown>).sessions)) {
          collected.push(...((ws as Record<string, unknown>).sessions as unknown[]))
        }
      }
    }
  }

  const entries: RestoreEntry[] = []
  for (const item of collected) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const name = typeof it.name === 'string' ? it.name : null
    const dir = typeof it.dir === 'string' ? it.dir : typeof it.cwd === 'string' ? it.cwd : null
    if (!name || !dir) continue
    const sessionId = typeof it.session_id === 'string' ? it.session_id : undefined
    entries.push({ name, dir: resolve(dir.replace(/^~/, homedir())), sessionId })
  }
  return entries
}
