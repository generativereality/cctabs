import { resolve } from 'path'
import { homedir } from 'os'
import type { RestoreEntry } from './restore-plan.js'
import { toLaunchableMode } from './session-status.js'
import { resolveTabColor } from './colors.js'

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
 *
 * `backend` / `config_dir` say which Claude account the session belongs to.
 * They're optional: restore infers both from wherever it finds the session, so
 * an older manifest still restores correctly. Carrying them matters when the
 * transcript isn't on this machine yet (an imported manifest) — there is
 * nothing to infer from, and resuming the id under the default config dir would
 * quietly open a fresh conversation instead.
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
    const backend = typeof it.backend === 'string' && it.backend ? it.backend : undefined
    const rawConfigDir = typeof it.config_dir === 'string' ? it.config_dir : null
    const configDir = rawConfigDir ? resolve(rawConfigDir.replace(/^~/, homedir())) : undefined
    // Validated rather than passed through: a hand-edited manifest, or one
    // built from a transcript, can carry a value `claude --permission-mode`
    // rejects (`default` occurs in real transcripts). An unusable value is
    // dropped so the entry falls back to the configured flags instead of
    // failing to launch at all.
    const permissionMode = toLaunchableMode(it.permission_mode)
    // Validated like permission_mode, and for the same reason: a hand-written
    // manifest may say "blue" where `sessions --json` emits "#0275d8", and an
    // unusable value must fall back to the configured colour rather than fail
    // the launch. `null` is meaningful — a tab deliberately left uncoloured —
    // so it is distinguished from absent.
    let color: string | null | undefined
    if (it.color === null) {
      color = null
    } else if (typeof it.color === 'string') {
      try { color = resolveTabColor(it.color) } catch { color = undefined }
    }
    entries.push({
      name,
      dir: resolve(dir.replace(/^~/, homedir())),
      sessionId,
      backend,
      configDir,
      permissionMode,
      color,
    })
  }
  return entries
}
