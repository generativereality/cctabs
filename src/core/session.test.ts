import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToProjectSlug, resolveTabSession } from './session.js'

/**
 * Write a fake Claude session .jsonl under the project slug for `dirForSlug`,
 * carrying a customTitle + cwd, and stamp its mtime so recency is controllable.
 */
function writeSession(
  projectsRoot: string,
  dirForSlug: string,
  opts: { id: string; title: string; cwd: string; mtimeSec: number },
): void {
  const projectDir = join(projectsRoot, pathToProjectSlug(dirForSlug))
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${opts.id}.jsonl`)
  const content =
    [
      JSON.stringify({ type: 'summary', customTitle: opts.title }),
      JSON.stringify({ type: 'user', cwd: opts.cwd, message: { role: 'user', content: 'hello' } }),
    ].join('\n') + '\n'
  writeFileSync(file, content)
  utimesSync(file, opts.mtimeSec, opts.mtimeSec)
}

describe('resolveTabSession', () => {
  let projectsRoot: string
  let repo: string

  beforeEach(() => {
    // Unique tmpdirs per test → unique project-dir cache keys, so the module's
    // title-index cache never bleeds between cases.
    projectsRoot = mkdtempSync(join(tmpdir(), 'cctabs-projects-'))
    repo = mkdtempSync(join(tmpdir(), 'cctabs-repo-'))
  })

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('prefers the worktree session over an older same-named repo-root session', () => {
    const wtPath = join(repo, '.claude', 'worktrees', 'gh-actions-proxy')
    // Older repo-root session that happens to share the tab name — the trap
    // that made restore resume the wrong conversation for worktree tabs.
    writeSession(projectsRoot, repo, {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'gh-actions-proxy',
      cwd: repo,
      mtimeSec: 1000,
    })
    // The actual (newer) worktree session.
    writeSession(projectsRoot, wtPath, {
      id: '22222222-2222-2222-2222-222222222222',
      title: 'gh-actions-proxy',
      cwd: wtPath,
      mtimeSec: 5000,
    })

    const r = resolveTabSession(repo, 'gh-actions-proxy', projectsRoot)
    expect(r?.id).toBe('22222222-2222-2222-2222-222222222222')
    expect(r?.dir).toBe(wtPath)
  })

  it('prefers the named worktree even when a repo-root session is NEWER', () => {
    const wtPath = join(repo, '.claude', 'worktrees', 'gh-actions-proxy')
    // Worktree session is older here…
    writeSession(projectsRoot, wtPath, {
      id: '22222222-2222-2222-2222-222222222222',
      title: 'gh-actions-proxy',
      cwd: wtPath,
      mtimeSec: 1000,
    })
    // …and a stale repo-root session of the same name was just touched (e.g. a
    // prior wrong restore). The named-worktree signal must still win.
    writeSession(projectsRoot, repo, {
      id: '11111111-1111-1111-1111-111111111111',
      title: 'gh-actions-proxy',
      cwd: repo,
      mtimeSec: 9000,
    })

    const r = resolveTabSession(repo, 'gh-actions-proxy', projectsRoot)
    expect(r?.id).toBe('22222222-2222-2222-2222-222222222222')
    expect(r?.dir).toBe(wtPath)
  })

  it('resolves a plain repo-root session when there is no worktree', () => {
    writeSession(projectsRoot, repo, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      title: 'migration-rollout',
      cwd: repo,
      mtimeSec: 1000,
    })
    const r = resolveTabSession(repo, 'migration-rollout', projectsRoot)
    expect(r?.id).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(r?.dir).toBe(repo)
  })

  it('returns null when no session matches the name', () => {
    writeSession(projectsRoot, repo, {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: 'something-else',
      cwd: repo,
      mtimeSec: 1000,
    })
    expect(resolveTabSession(repo, 'nonexistent', projectsRoot)).toBeNull()
  })
})
