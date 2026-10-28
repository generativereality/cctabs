import { resolve, sep } from 'path'
import { resolveCopyTargetCwd } from './session-copy.js'

export interface SessionDir {
  /** Where to resume the session. */
  dir: string
  /**
   * The directory that was proposed (a tab's cwd, a manifest's `dir`) when the
   * transcript overruled it. Absent when they agree.
   */
  overruled?: string
}

/** `a` and `b` are the same directory, or one is inside the other. Pure. */
export function nestedOrSame(a: string, b: string): boolean {
  const x = resolve(a)
  const y = resolve(b)
  return x === y || x.startsWith(y + sep) || y.startsWith(x + sep)
}

/**
 * Where a session should be resumed: what its transcript recorded, not where a
 * tab happens to sit.
 *
 * A tab's cwd is only evidence about the shell in it. Once a session id comes
 * from somewhere other than the tab's directory — Claude's registry, its argv,
 * a manifest — nothing ties the two together, and the wrong one is
 * self-perpetuating: the snapshot records the tab's dir, restore resumes there
 * with `cd <dir> && claude --resume`, and the next snapshot sees the same dir.
 * Measured: a session whose whole conversation was in a notes vault came back
 * in an unrelated repo's worktree and loaded that repo's CLAUDE.md, so "commit
 * and push" pointed at the wrong repo.
 *
 * The transcript's last recorded cwd that still exists wins (see
 * `resolveCopyTargetCwd`). The proposed dir is kept when it is the same
 * directory or nested with the recorded one — the repo root of a worktree
 * session, a subdirectory — because those resume the same tree, and a manifest
 * dir may be deliberate. When the transcript records nothing usable, the
 * proposed dir is all there is.
 */
export function sessionDirFromTranscript(transcript: string | undefined, proposed: string | undefined): SessionDir | null {
  const recorded = transcript ? resolveCopyTargetCwd(transcript) : null
  if (!recorded) return proposed ? { dir: proposed } : null
  if (!proposed) return { dir: recorded.dir }
  if (nestedOrSame(proposed, recorded.dir)) return { dir: proposed }
  return { dir: recorded.dir, overruled: proposed }
}
