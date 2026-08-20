import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs'
import { basename, join } from 'path'
import { pathToProjectSlug } from './session.js'
import { repoRootOf } from './worktree.js'

/**
 * Copying a Claude session between config dirs is more than copying one file,
 * and every extra piece here is something that silently loses data if skipped.
 * The three that matter:
 *
 *   1. The sidecar directory (below) holds subagent transcripts and tool
 *      results. One real session had 357 files in it. Copying only the .jsonl
 *      leaves a conversation that resumes and has forgotten every subagent.
 *   2. Which project slug to file the copy under is a *choice*, not a given —
 *      see resolveCopyTargetCwd(). Reusing the source slug reproduces the
 *      dead-worktree failure in the target profile.
 *   3. A transcript that is metadata-only is not a conversation but still
 *      carries a customTitle, which is what name resolution matches on. Left
 *      in place it shadows the very session it was left behind by.
 */

/**
 * The directory Claude Code keeps beside a transcript, named for the session id
 * and holding `subagents/` and `tool-results/`.
 *
 * Note it is matched by *name*, never by "any sibling directory": a project dir
 * can also contain unrelated directories (`memory/`, for one), and sweeping
 * those into a session copy would be worse than missing the sidecar.
 */
export function sidecarDirFor(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '')
}

/** Recursively count files under `dir` (0 when it doesn't exist). */
export function countFilesRecursive(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += countFilesRecursive(full)
    else total += 1
  }
  return total
}

/** Recursively copy `src` to `dst`, returning the number of files written. */
export function copyDirRecursive(src: string, dst: string): number {
  mkdirSync(dst, { recursive: true })
  let copied = 0
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      copied += copyDirRecursive(from, to)
    } else if (entry.isFile()) {
      copyFileSync(from, to)
      copied += 1
    }
    // Symlinks and sockets are skipped deliberately — Claude Code writes plain
    // files here, and following a link out of the sidecar would copy who knows
    // what into another profile.
  }
  return copied
}

/** Entry types that constitute an actual conversation, as opposed to metadata. */
const CONVERSATION_TYPES = new Set(['user', 'assistant'])

/**
 * True when a transcript holds only metadata and no conversation.
 *
 * A closing Claude Code process writes a short trailer — `custom-title`,
 * `agent-name`, `mode`, `permission-mode`, `pr-link` — to its transcript path.
 * If the real transcript has already been moved away, that trailer *recreates*
 * the file: a handful of lines, no messages, and a `customTitle`. Since name
 * resolution keys off customTitle and prefers the newest mtime, the freshly
 * written stub outranks the relocated original and quietly shadows it on the
 * next `restore`.
 */
export function isMetadataOnlyTranscript(file: string, sessionId?: string): boolean {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return false
  }
  let sawAny = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: unknown; sessionId?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      // An unparseable line means this isn't a tidy little trailer. Refuse to
      // call it a stub rather than risk deleting a damaged real transcript.
      return false
    }
    sawAny = true
    if (typeof entry.type === 'string' && CONVERSATION_TYPES.has(entry.type)) return false
    // Every trailer line names the session it belongs to. Requiring the match
    // keeps this from ever firing on some unrelated file that happens to be
    // short.
    if (sessionId && entry.sessionId !== undefined && entry.sessionId !== sessionId) return false
  }
  return sawAny
}

export interface CopyTargetCwd {
  /** Directory whose project slug the copy should be filed under. */
  dir: string
  /** Why this directory, for the command to report. */
  reason: 'recorded-cwd' | 'repo-root' | 'fallback'
}

/**
 * Which directory's project slug a copied session should be filed under.
 *
 * Two independent traps here, both hit in practice:
 *
 *   - The transcript is filed under the slug of the cwd the session *started*
 *     in, but a session can move: started in one worktree, `cd`'d elsewhere,
 *     ended in another. If the starting worktree has since been deleted and the
 *     later one still exists, filing the copy under the transcript's own slug
 *     reproduces the dead-path problem in the target profile. So we prefer the
 *     LAST recorded cwd that still exists, scanning backwards.
 *   - If no recorded cwd exists any more (the usual "deleted worktree" case),
 *     fall back to the repo root. `claude --resume <id>` fails with "No
 *     conversation found with session ID" when the id is filed under a slug
 *     whose directory is gone, even though the transcript is right there;
 *     re-filing under the repo-root slug is what makes it resumable again.
 */
export function resolveCopyTargetCwd(jsonlPath: string, fallbackCwd?: string): CopyTargetCwd | null {
  let lines: string[] = []
  try {
    lines = readFileSync(jsonlPath, 'utf-8').split('\n')
  } catch {
    lines = []
  }

  // Backwards, so the common case (the newest cwd still exists) costs one parse
  // rather than a full-file scan. Distinct values only — a long session repeats
  // its cwd on every message.
  const seen = new Set<string>()
  let newest: string | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"cwd"')) continue
    let entry: { cwd?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof entry.cwd !== 'string' || !entry.cwd) continue
    if (seen.has(entry.cwd)) continue
    seen.add(entry.cwd)
    newest ??= entry.cwd
    if (existsSync(entry.cwd)) return { dir: entry.cwd, reason: 'recorded-cwd' }
  }

  // Nothing recorded still exists. The repo root of the most recent one is the
  // directory a human would resume from.
  if (newest) {
    const root = repoRootOf(newest)
    if (root !== newest && existsSync(root)) return { dir: root, reason: 'repo-root' }
  }
  if (fallbackCwd && existsSync(fallbackCwd)) return { dir: fallbackCwd, reason: 'fallback' }
  return null
}

export interface SessionCopyPlan {
  sessionId: string
  sourceJsonl: string
  /** Sidecar beside the source transcript, when there is one. */
  sourceSidecar: string | null
  sidecarFileCount: number
  /** Directory whose slug the copy is filed under, and why. */
  target: CopyTargetCwd
  targetProjectDir: string
  targetJsonl: string
  /**
   * True when the copy lands under a different slug than the source, i.e. the
   * session is being relocated as well as copied. Worth reporting: it's the
   * fix for a dead recorded cwd, and it's also the case that leaves a stale
   * source project dir behind.
   */
  relocated: boolean
}

/**
 * Work out where a session copy goes without touching the filesystem, so the
 * command can report a faithful `--dry`.
 */
export function planSessionCopy(opts: {
  sessionId: string
  sourceJsonl: string
  targetProjectsRoot: string
  fallbackCwd?: string
}): SessionCopyPlan | null {
  const { sessionId, sourceJsonl, targetProjectsRoot, fallbackCwd } = opts
  const target = resolveCopyTargetCwd(sourceJsonl, fallbackCwd)
  if (!target) return null

  const sidecar = sidecarDirFor(sourceJsonl)
  const hasSidecar = existsSync(sidecar) && statSync(sidecar).isDirectory()
  const targetProjectDir = join(targetProjectsRoot, pathToProjectSlug(target.dir))

  return {
    sessionId,
    sourceJsonl,
    sourceSidecar: hasSidecar ? sidecar : null,
    sidecarFileCount: hasSidecar ? countFilesRecursive(sidecar) : 0,
    target,
    targetProjectDir,
    targetJsonl: join(targetProjectDir, `${sessionId}.jsonl`),
    relocated: basename(targetProjectDir) !== basename(join(sourceJsonl, '..')),
  }
}

export interface SessionCopyResult {
  sidecarFilesCopied: number
}

/**
 * Copy a session's transcript and sidecar into the planned location.
 *
 * Always a copy, never a rename, even when `--move` was asked for: a rename
 * within one filesystem keeps the inode, so a still-running `claude` writes
 * straight through to the moved file and two conversations interleave into one
 * unusable transcript. Removal of the source is a separate, explicitly-ordered
 * step (see `removeSourceSession`) that only runs once the source is known dead.
 */
export function executeSessionCopy(plan: SessionCopyPlan, opts: { overwrite?: boolean } = {}): SessionCopyResult {
  if (existsSync(plan.targetJsonl) && !opts.overwrite) {
    throw new Error(`${plan.targetJsonl} already exists (pass --force to overwrite)`)
  }
  mkdirSync(plan.targetProjectDir, { recursive: true })
  copyFileSync(plan.sourceJsonl, plan.targetJsonl)

  let sidecarFilesCopied = 0
  if (plan.sourceSidecar) {
    const targetSidecar = sidecarDirFor(plan.targetJsonl)
    sidecarFilesCopied = copyDirRecursive(plan.sourceSidecar, targetSidecar)
  }
  return { sidecarFilesCopied }
}

export interface SourceRemoval {
  removedJsonl: boolean
  removedSidecar: boolean
  /** A metadata-only trailer the dying process re-created, swept afterwards. */
  sweptStub: boolean
}

/**
 * Delete a session's transcript and sidecar from the profile it was copied out
 * of, then sweep the trailer its process may have written on the way out.
 *
 * The second half is not tidiness. A closing Claude Code writes a metadata
 * trailer back to the original path *after* the tab is reported closed, and
 * that trailer carries a customTitle with a brand-new mtime — precisely the
 * artefact that shadows the session that was just moved. So: delete, then look
 * again, and delete again if something reappeared.
 */
export function removeSourceSession(sourceJsonl: string, sessionId: string): SourceRemoval {
  const sidecar = sidecarDirFor(sourceJsonl)
  const result: SourceRemoval = { removedJsonl: false, removedSidecar: false, sweptStub: false }

  if (existsSync(sidecar)) {
    rmSync(sidecar, { recursive: true, force: true })
    result.removedSidecar = true
  }
  if (existsSync(sourceJsonl)) {
    rmSync(sourceJsonl, { force: true })
    result.removedJsonl = true
  }

  // Re-check: only ever remove what is provably a metadata-only trailer for
  // this exact session. Anything else is left alone and reported.
  if (existsSync(sourceJsonl) && isMetadataOnlyTranscript(sourceJsonl, sessionId)) {
    rmSync(sourceJsonl, { force: true })
    result.sweptStub = true
  }
  return result
}

/** Any metadata-only trailer for `sessionId` still sitting at `sourceJsonl`. */
export function sweepMetadataStub(sourceJsonl: string, sessionId: string): boolean {
  if (!existsSync(sourceJsonl)) return false
  if (!isMetadataOnlyTranscript(sourceJsonl, sessionId)) return false
  rmSync(sourceJsonl, { force: true })
  return true
}

/** Where archived project dirs go: beside `projects/`, deliberately not inside it. */
export const ARCHIVE_DIR_NAME = 'cctabs-archived-projects'

/** True when a project dir holds no transcripts at all any more. */
export function projectDirHasTranscripts(projectDir: string): boolean {
  if (!existsSync(projectDir)) return false
  try {
    return readdirSync(projectDir).some((f) => f.endsWith('.jsonl'))
  } catch {
    return false
  }
}

/**
 * Move a stale project directory out of `projects/` entirely.
 *
 * Renaming it in place is not enough, and the reason is easy to get wrong:
 * resolution matches on the `customTitle` *inside* the transcripts, not on the
 * directory name, so a renamed directory keeps shadowing. It also treats the
 * existence of a worktree-named project dir as evidence that the worktree still
 * exists, which is what sends a restore into a deleted path. Only getting the
 * directory out from under `projects/` fixes both.
 *
 * Returns the archive path, or null when there was nothing to archive.
 */
export function archiveProjectDir(projectDir: string, configRoot: string, stamp: string): string | null {
  if (!existsSync(projectDir)) return null
  const archiveRoot = join(configRoot, ARCHIVE_DIR_NAME)
  mkdirSync(archiveRoot, { recursive: true })
  let dest = join(archiveRoot, `${basename(projectDir)}-${stamp}`)
  let n = 2
  while (existsSync(dest)) dest = join(archiveRoot, `${basename(projectDir)}-${stamp}-${n++}`)
  renameSync(projectDir, dest)
  return dest
}
