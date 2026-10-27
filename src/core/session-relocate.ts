import { existsSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { pathToProjectSlug } from './session.js'
import { isTrailerFile } from './transcript-kind.js'
import {
  countFilesRecursive,
  resolveCopyTargetCwd,
  sidecarDirFor,
  type SessionCopyPlan,
} from './session-copy.js'

/**
 * `cctabs resume <name> <repo> -s <id>` for a session whose worktree is gone.
 *
 * Claude Code files a transcript under the slug of the cwd it started in. Once
 * that worktree is deleted the transcript is still on disk, but under a folder
 * no live directory maps to: an older Claude Code then answers `--resume` with
 * "No conversation found", and `restore` treats the leftover worktree-named
 * folder as evidence the worktree still exists. The skill used to give a `cp`
 * recipe for this, and a copy of only the `.jsonl` lost every subagent
 * transcript in the sidecar beside it. This plans the same move the copy
 * helpers already make safely between accounts, within one config dir.
 */

/** The transcript for `sessionId` anywhere under one projects root. */
export function findTranscriptInProjects(projectsRoot: string, sessionId: string): string | null {
  if (!existsSync(projectsRoot)) return null
  for (const d of readdirSync(projectsRoot)) {
    const file = join(projectsRoot, d, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    if (isTrailerFile(file, sessionId)) continue
    return file
  }
  return null
}

export type RelocationDecision =
  | { kind: 'none'; reason: 'already-here' | 'not-found' | 'cwd-alive' }
  | { kind: 'relocate'; plan: SessionCopyPlan }

/**
 * Should resuming `sessionId` into `dir` first move its transcript? Only when
 * it is filed somewhere else AND none of the directories it recorded still
 * exists: a session filed under a live worktree is that worktree's, and moving
 * it would take it away from there. Reads only; the caller copies.
 */
export function planResumeRelocation(opts: {
  sessionId: string
  dir: string
  projectsRoot: string
}): RelocationDecision {
  const { sessionId, dir, projectsRoot } = opts
  const targetProjectDir = join(projectsRoot, pathToProjectSlug(dir))
  const targetJsonl = join(targetProjectDir, `${sessionId}.jsonl`)
  if (existsSync(targetJsonl) && !isTrailerFile(targetJsonl, sessionId)) return { kind: 'none', reason: 'already-here' }

  const sourceJsonl = findTranscriptInProjects(projectsRoot, sessionId)
  if (!sourceJsonl || sourceJsonl === targetJsonl) return { kind: 'none', reason: 'not-found' }

  const recorded = resolveCopyTargetCwd(sourceJsonl)
  if (recorded?.reason === 'recorded-cwd') return { kind: 'none', reason: 'cwd-alive' }

  const sidecar = sidecarDirFor(sourceJsonl)
  const hasSidecar = existsSync(sidecar) && statSync(sidecar).isDirectory()
  return {
    kind: 'relocate',
    plan: {
      sessionId,
      sourceJsonl,
      sourceSidecar: hasSidecar ? sidecar : null,
      sidecarFileCount: hasSidecar ? countFilesRecursive(sidecar) : 0,
      target: { dir, reason: 'fallback' },
      targetProjectDir,
      targetJsonl,
      relocated: basename(targetProjectDir) !== basename(join(sourceJsonl, '..')),
    },
  }
}
