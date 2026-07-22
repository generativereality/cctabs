import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToProjectSlug, resolveTabSession, findSessionsByNameGlobally, findSessionFileById, persistSessionTitle } from './session.js'
import { readFileSync } from 'fs'

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

/**
 * Like writeSession, but the recorded cwd changes partway through — simulating
 * a session that started in one directory (e.g. a worktree) and was later
 * resumed from another (e.g. the repo root, after the worktree was deleted).
 */
function writeSessionWithCwdChange(
  projectsRoot: string,
  dirForSlug: string,
  opts: { id: string; title: string; firstCwd: string; laterCwd: string; mtimeSec: number },
): void {
  const projectDir = join(projectsRoot, pathToProjectSlug(dirForSlug))
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${opts.id}.jsonl`)
  const content =
    [
      JSON.stringify({ type: 'summary', customTitle: opts.title }),
      JSON.stringify({ type: 'user', cwd: opts.firstCwd, message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', cwd: opts.firstCwd, message: { role: 'assistant', content: 'hi' } }),
      JSON.stringify({ type: 'user', cwd: opts.laterCwd, message: { role: 'user', content: 'still here' } }),
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

  it('resolves to the LAST recorded cwd, not the first, when a session moved directories mid-life', () => {
    // Session started in a worktree that has since been deleted, then was
    // manually resumed from the repo root — the exact scenario that made
    // restore try to relaunch into a directory that no longer exists.
    const wtPath = join(repo, '.claude', 'worktrees', 'synced-docs')
    writeSessionWithCwdChange(projectsRoot, repo, {
      id: '33333333-3333-3333-3333-333333333333',
      title: 'synced-docs',
      firstCwd: wtPath,
      laterCwd: repo,
      mtimeSec: 1000,
    })

    const r = resolveTabSession(repo, 'synced-docs', projectsRoot)
    expect(r?.id).toBe('33333333-3333-3333-3333-333333333333')
    expect(r?.dir).toBe(repo)
  })

  it('ignores a cwd that drifted via `cd <subdir>` mid-session — the transcript never moved', () => {
    // The agent ran `cd website-clerkai` via the Bash tool partway through the
    // session. Claude Code's per-message cwd tracks that logical drift, but
    // the transcript file is still physically stored under repo's own slug —
    // there is no session file at all under the subdirectory's slug. Trusting
    // the drifted cwd made `restore` fail with "No conversation found".
    const subdir = join(repo, 'website-clerkai')
    writeSessionWithCwdChange(projectsRoot, repo, {
      id: '55555555-5555-5555-5555-555555555555',
      title: 'rt',
      firstCwd: repo,
      laterCwd: subdir,
      mtimeSec: 1000,
    })

    const r = resolveTabSession(repo, 'rt', projectsRoot)
    expect(r?.id).toBe('55555555-5555-5555-5555-555555555555')
    expect(r?.dir).toBe(repo)
  })
})

describe('findSessionsByNameGlobally', () => {
  let projectsRoot: string
  let repo: string

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'cctabs-projects-'))
    repo = mkdtempSync(join(tmpdir(), 'cctabs-repo-'))
  })

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('resolves to the LAST recorded cwd, not the first, when a session moved directories mid-life', () => {
    const wtPath = join(repo, '.claude', 'worktrees', 'synced-docs')
    writeSessionWithCwdChange(projectsRoot, repo, {
      id: '44444444-4444-4444-4444-444444444444',
      title: 'synced-docs',
      firstCwd: wtPath,
      laterCwd: repo,
      mtimeSec: 1000,
    })

    const matches = findSessionsByNameGlobally('synced-docs', projectsRoot)
    expect(matches).toHaveLength(1)
    expect(matches[0].dir).toBe(repo)
  })

  it('ignores a cwd that drifted via `cd <subdir>` mid-session — the transcript never moved', () => {
    const subdir = join(repo, 'website-clerkai')
    writeSessionWithCwdChange(projectsRoot, repo, {
      id: '66666666-6666-6666-6666-666666666666',
      title: 'rt',
      firstCwd: repo,
      laterCwd: subdir,
      mtimeSec: 1000,
    })

    const matches = findSessionsByNameGlobally('rt', projectsRoot)
    expect(matches).toHaveLength(1)
    expect(matches[0].dir).toBe(repo)
  })
})

describe('rename persistence (findSessionFileById + persistSessionTitle)', () => {
  let projectsRoot: string
  let repo: string

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'cctabs-projects-'))
    repo = mkdtempSync(join(tmpdir(), 'cctabs-repo-'))
  })

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  it('locates a session file in the cwd project dir', () => {
    writeSession(projectsRoot, repo, {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      title: 'old-name',
      cwd: repo,
      mtimeSec: 1000,
    })
    const file = findSessionFileById('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [repo], projectsRoot)
    expect(file).toBe(
      join(projectsRoot, pathToProjectSlug(repo), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
    )
  })

  it('locates a worktree session by its launch dir even if the physical worktree is gone', () => {
    // The worktree dir under `repo` is intentionally never created — only its
    // project slug dir exists, mirroring a deleted worktree whose session
    // remains resumable. Deriving the slug from the dir must still find it.
    const wtPath = join(repo, '.claude', 'worktrees', 'feature-x')
    writeSession(projectsRoot, wtPath, {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      title: 'feature-x',
      cwd: wtPath,
      mtimeSec: 1000,
    })
    // First candidate (repo) has no such file; second (the worktree launch dir) does.
    const file = findSessionFileById('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', [repo, wtPath], projectsRoot)
    expect(file).toBe(
      join(projectsRoot, pathToProjectSlug(wtPath), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl'),
    )
  })

  it('returns null when no file matches the id', () => {
    expect(findSessionFileById('no-such-id', [repo], projectsRoot)).toBeNull()
  })

  it('appends a custom-title line so resolveTabSession picks up the new name', () => {
    const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    writeSession(projectsRoot, repo, { id, title: 'old-name', cwd: repo, mtimeSec: 1000 })

    // Before: only the old name resolves.
    expect(resolveTabSession(repo, 'old-name', projectsRoot)?.id).toBe(id)
    expect(resolveTabSession(repo, 'new-name', projectsRoot)).toBeNull()

    const file = findSessionFileById(id, [repo], projectsRoot)!
    persistSessionTitle(file, id, 'new-name')

    // The appended line is a well-formed custom-title entry on its own line.
    const lines = readFileSync(file, 'utf-8').trimEnd().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    expect(last).toEqual({ type: 'custom-title', customTitle: 'new-name', sessionId: id })

    // After (fresh module cache via a distinct projectsRoot would be needed for
    // resolveTabSession, but findSessionsByNameGlobally is cache-free): the new
    // name now wins as the last customTitle.
    const byNew = findSessionsByNameGlobally('new-name', projectsRoot)
    expect(byNew.map((m) => m.id)).toContain(id)
    expect(findSessionsByNameGlobally('old-name', projectsRoot)).toHaveLength(0)
  })
})
