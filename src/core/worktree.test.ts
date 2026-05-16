import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupWorktree } from './worktree.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()
}

/** Build a repo with `main` at one commit and `next` two commits ahead. Returns the path. */
function buildRepoOnNext(): { dir: string; mainHead: string; nextHead: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cctabs-wt-'))
  git(dir, 'init', '-q')
  // Make sure we end up with branch named 'main' regardless of git init.defaultBranch
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'init main')
  // Rename whatever the initial branch is to 'main'
  const current = git(dir, 'branch', '--show-current')
  if (current !== 'main') git(dir, 'branch', '-m', current, 'main')
  const mainHead = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'switch', '-q', '-c', 'next')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'next 1')
  git(dir, 'commit', '--allow-empty', '-q', '-m', 'next 2')
  const nextHead = git(dir, 'rev-parse', 'HEAD')
  return { dir, mainHead, nextHead }
}

describe('setupWorktree', () => {
  let repo: ReturnType<typeof buildRepoOnNext>

  beforeEach(() => {
    repo = buildRepoOnNext()
  })

  afterEach(() => {
    rmSync(repo.dir, { recursive: true, force: true })
  })

  it('anchors a fresh worktree at the target dir current HEAD', () => {
    const result = setupWorktree(repo.dir, 'bench')

    expect(result.created).toBe(true)
    expect(result.reusedBranch).toBe(false)
    expect(result.worktreePath).toBe(join(repo.dir, '.claude', 'worktrees', 'bench'))
    expect(result.branchName).toBe('worktree-bench')
    expect(result.baseSha).toBe(repo.nextHead)
    expect(result.parentHeadSha).toBe(repo.nextHead)

    // Verify on disk
    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(repo.nextHead)
    expect(git(result.worktreePath, 'branch', '--show-current')).toBe('worktree-bench')
  })

  it('reuses an existing worktree path without recreating', () => {
    const first = setupWorktree(repo.dir, 'bench')
    writeFileSync(join(first.worktreePath, 'sentinel.txt'), 'still here')

    const second = setupWorktree(repo.dir, 'bench')

    expect(second.created).toBe(false)
    expect(second.worktreePath).toBe(first.worktreePath)
    expect(second.baseSha).toBe(repo.nextHead)
    expect(existsSync(join(second.worktreePath, 'sentinel.txt'))).toBe(true)
  })

  it('reuses an existing branch and signals reusedBranch=true', () => {
    // Pre-create the branch at main HEAD (not next HEAD) to simulate a prior run
    // that already claimed the worktree-bench name at a different commit.
    git(repo.dir, 'branch', 'worktree-bench', 'main')

    const result = setupWorktree(repo.dir, 'bench')

    expect(result.created).toBe(true)
    expect(result.reusedBranch).toBe(true)
    expect(result.parentHeadSha).toBe(repo.nextHead)
    // The worktree gets the pre-existing branch's tip, NOT the parent dir's HEAD.
    expect(result.baseSha).toBe(repo.mainHead)
    expect(git(result.worktreePath, 'branch', '--show-current')).toBe('worktree-bench')
  })

  it('throws a clear error when target dir is not a git repo', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'cctabs-wt-nonrepo-'))
    try {
      expect(() => setupWorktree(nonRepo, 'bench')).toThrow(/Not a git repository/)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('works from a detached HEAD (anchors at the current commit)', () => {
    git(repo.dir, 'checkout', '-q', '--detach', repo.nextHead)

    const result = setupWorktree(repo.dir, 'detached-bench')

    expect(result.parentHeadSha).toBe(repo.nextHead)
    expect(result.baseSha).toBe(repo.nextHead)
    expect(git(result.worktreePath, 'rev-parse', 'HEAD')).toBe(repo.nextHead)
  })
})
