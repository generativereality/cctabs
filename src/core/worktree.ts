import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'

export interface WorktreeSetup {
  /** Absolute path of the worktree (`<dir>/.claude/worktrees/<name>`). */
  worktreePath: string
  /** Branch checked out in the worktree (`worktree-<name>`). */
  branchName: string
  /** SHA actually checked out in the worktree after setup. */
  baseSha: string
  /** SHA of <dir>'s HEAD at setup time (what we tried to anchor to). */
  parentHeadSha: string
  /** True if the worktree was newly created; false if a pre-existing one was reused. */
  created: boolean
  /** True if a branch named `worktree-<name>` already existed and was reused. */
  reusedBranch: boolean
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Create (or reuse) `<dir>/.claude/worktrees/<name>` anchored at <dir>'s current HEAD.
 *
 * Why this exists: `claude --worktree <name>` historically does not always branch
 * from the current HEAD — with un-pushed local commits it can branch from the
 * upstream tracking ref instead, silently producing a worktree at a stale
 * commit. cctabs creates the worktree explicitly so the new tab starts from
 * exactly the commit the parent session was working on.
 */
export function setupWorktree(dir: string, name: string): WorktreeSetup {
  const absDir = resolve(dir.replace(/^~/, homedir()))
  const worktreePath = join(absDir, '.claude', 'worktrees', name)
  const branchName = `worktree-${name}`

  try {
    runGit(absDir, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    throw new Error(`Not a git repository: ${absDir}`)
  }

  const parentHeadSha = runGit(absDir, ['rev-parse', 'HEAD'])

  if (existsSync(worktreePath)) {
    const baseSha = runGit(worktreePath, ['rev-parse', 'HEAD'])
    return { worktreePath, branchName, baseSha, parentHeadSha, created: false, reusedBranch: false }
  }

  const branchExists = (() => {
    try {
      runGit(absDir, ['show-ref', '--verify', `refs/heads/${branchName}`])
      return true
    } catch {
      return false
    }
  })()

  try {
    if (branchExists) {
      runGit(absDir, ['worktree', 'add', worktreePath, branchName])
    } else {
      runGit(absDir, ['worktree', 'add', '-b', branchName, worktreePath, parentHeadSha])
    }
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() ?? e?.message ?? String(e)
    throw new Error(`git worktree add failed for ${worktreePath}: ${stderr.trim()}`)
  }

  const baseSha = runGit(worktreePath, ['rev-parse', 'HEAD'])
  return { worktreePath, branchName, baseSha, parentHeadSha, created: true, reusedBranch: branchExists }
}
