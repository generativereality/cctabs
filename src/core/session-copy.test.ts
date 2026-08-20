import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  ARCHIVE_DIR_NAME,
  archiveProjectDir,
  copyDirRecursive,
  countFilesRecursive,
  executeSessionCopy,
  isMetadataOnlyTranscript,
  planSessionCopy,
  projectDirHasTranscripts,
  removeSourceSession,
  resolveCopyTargetCwd,
  sidecarDirFor,
  sweepMetadataStub,
} from './session-copy.js'
import { pathToProjectSlug } from './session.js'

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** A conversation line carrying a cwd, as Claude Code writes them. */
function msg(cwd: string, type = 'user'): string {
  return JSON.stringify({ type, cwd, sessionId: SESSION, message: { role: type, content: 'hi' } })
}

describe('sidecarDirFor', () => {
  it('is the transcript path minus .jsonl', () => {
    expect(sidecarDirFor('/p/-slug/abc.jsonl')).toBe('/p/-slug/abc')
  })
})

describe('isMetadataOnlyTranscript', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cctabs-stub-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (name: string, lines: string[]): string => {
    const f = join(dir, name)
    writeFileSync(f, lines.map((l) => l + '\n').join(''))
    return f
  }

  it('recognises the trailer a closing Claude writes back', () => {
    // Exactly the shape observed on disk: no conversation, but a customTitle —
    // which is what name resolution matches on, so it shadows silently.
    const f = write('stub.jsonl', [
      JSON.stringify({ type: 'custom-title', customTitle: 'audit', sessionId: SESSION }),
      JSON.stringify({ type: 'agent-name', agentName: 'x', sessionId: SESSION }),
      JSON.stringify({ type: 'mode', mode: 'x', sessionId: SESSION }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'plan', sessionId: SESSION }),
      JSON.stringify({ type: 'pr-link', prNumber: 1, sessionId: SESSION }),
    ])
    expect(isMetadataOnlyTranscript(f, SESSION)).toBe(true)
  })

  it('refuses to call a real transcript a stub', () => {
    const f = write('real.jsonl', [
      JSON.stringify({ type: 'custom-title', customTitle: 'audit', sessionId: SESSION }),
      msg('/tmp/repo'),
    ])
    expect(isMetadataOnlyTranscript(f, SESSION)).toBe(false)
  })

  it('refuses when the lines belong to a different session', () => {
    const f = write('other.jsonl', [
      JSON.stringify({ type: 'custom-title', customTitle: 'audit', sessionId: 'someone-else' }),
    ])
    expect(isMetadataOnlyTranscript(f, SESSION)).toBe(false)
  })

  it('refuses on an unparseable line rather than risk deleting damaged data', () => {
    const f = write('broken.jsonl', ['{not json'])
    expect(isMetadataOnlyTranscript(f, SESSION)).toBe(false)
  })

  it('is false for an empty file', () => {
    expect(isMetadataOnlyTranscript(write('empty.jsonl', []), SESSION)).toBe(false)
  })
})

describe('resolveCopyTargetCwd', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cctabs-cwd-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('prefers the LAST recorded cwd that still exists, not the first', () => {
    // The real failure: a session started in one worktree, cd'd to another, and
    // the *first* worktree was later deleted. The transcript is filed under the
    // dead one, so filing the copy there would reproduce the problem.
    const dead = join(root, '.claude', 'worktrees', 'audit-source')
    const live = join(root, '.claude', 'worktrees', 'conductor-jobs-access')
    mkdirSync(live, { recursive: true })
    const f = join(root, 't.jsonl')
    writeFileSync(f, [msg(dead), msg(dead), msg(live)].map((l) => l + '\n').join(''))

    expect(resolveCopyTargetCwd(f)).toEqual({ dir: live, reason: 'recorded-cwd' })
  })

  it('falls back to the repo root when no recorded cwd exists any more', () => {
    // `claude --resume` fails with "No conversation found with session ID" when
    // the id is filed under a slug whose directory is gone — even though the
    // transcript is right there. The repo-root slug is what makes it resumable.
    const dead = join(root, '.claude', 'worktrees', 'gone')
    const f = join(root, 't.jsonl')
    writeFileSync(f, msg(dead) + '\n')

    expect(resolveCopyTargetCwd(f)).toEqual({ dir: root, reason: 'repo-root' })
  })

  it('uses the caller fallback when the transcript records nothing usable', () => {
    const f = join(root, 't.jsonl')
    writeFileSync(f, JSON.stringify({ type: 'custom-title', customTitle: 'x' }) + '\n')
    expect(resolveCopyTargetCwd(f, root)).toEqual({ dir: root, reason: 'fallback' })
  })

  it('returns null when there is nowhere resumable to file the copy', () => {
    const f = join(root, 't.jsonl')
    writeFileSync(f, msg('/nonexistent/path/xyz') + '\n')
    expect(resolveCopyTargetCwd(f)).toBeNull()
  })
})

describe('copyDirRecursive / countFilesRecursive', () => {
  let src: string
  let dst: string
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'cctabs-src-'))
    dst = join(mkdtempSync(join(tmpdir(), 'cctabs-dst-')), 'out')
  })
  afterEach(() => {
    rmSync(src, { recursive: true, force: true })
    rmSync(join(dst, '..'), { recursive: true, force: true })
  })

  it('copies nested subagents/ and tool-results/ trees', () => {
    mkdirSync(join(src, 'subagents'), { recursive: true })
    mkdirSync(join(src, 'tool-results', 'deep'), { recursive: true })
    writeFileSync(join(src, 'subagents', 'a.jsonl'), 'a\n')
    writeFileSync(join(src, 'subagents', 'b.jsonl'), 'b\n')
    writeFileSync(join(src, 'tool-results', 'deep', 'c.json'), 'c\n')

    expect(countFilesRecursive(src)).toBe(3)
    expect(copyDirRecursive(src, dst)).toBe(3)
    expect(existsSync(join(dst, 'subagents', 'b.jsonl'))).toBe(true)
    expect(existsSync(join(dst, 'tool-results', 'deep', 'c.json'))).toBe(true)
  })

  it('counts nothing for a directory that does not exist', () => {
    expect(countFilesRecursive(join(src, 'nope'))).toBe(0)
  })
})

describe('planSessionCopy / executeSessionCopy', () => {
  let repo: string
  let sourceProjects: string
  let targetProjects: string
  let sourceJsonl: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cctabs-repo-'))
    sourceProjects = mkdtempSync(join(tmpdir(), 'cctabs-src-projects-'))
    targetProjects = mkdtempSync(join(tmpdir(), 'cctabs-dst-projects-'))
    const slugDir = join(sourceProjects, pathToProjectSlug(repo))
    mkdirSync(slugDir, { recursive: true })
    sourceJsonl = join(slugDir, `${SESSION}.jsonl`)
    writeFileSync(sourceJsonl, msg(repo) + '\n')
  })
  afterEach(() => {
    for (const d of [repo, sourceProjects, targetProjects]) rmSync(d, { recursive: true, force: true })
  })

  it('files the copy under the same slug when the cwd still exists', () => {
    const plan = planSessionCopy({ sessionId: SESSION, sourceJsonl, targetProjectsRoot: targetProjects })!
    expect(plan.target).toEqual({ dir: repo, reason: 'recorded-cwd' })
    expect(plan.targetJsonl).toBe(join(targetProjects, pathToProjectSlug(repo), `${SESSION}.jsonl`))
    expect(plan.relocated).toBe(false)
  })

  it('carries the sidecar across, not just the transcript', () => {
    const sidecar = sidecarDirFor(sourceJsonl)
    mkdirSync(join(sidecar, 'subagents'), { recursive: true })
    writeFileSync(join(sidecar, 'subagents', 'sub.jsonl'), 'x\n')

    const plan = planSessionCopy({ sessionId: SESSION, sourceJsonl, targetProjectsRoot: targetProjects })!
    expect(plan.sidecarFileCount).toBe(1)

    const { sidecarFilesCopied } = executeSessionCopy(plan)
    expect(sidecarFilesCopied).toBe(1)
    expect(existsSync(join(sidecarDirFor(plan.targetJsonl), 'subagents', 'sub.jsonl'))).toBe(true)
  })

  it('refuses to clobber an existing target unless told to', () => {
    const plan = planSessionCopy({ sessionId: SESSION, sourceJsonl, targetProjectsRoot: targetProjects })!
    executeSessionCopy(plan)
    expect(() => executeSessionCopy(plan)).toThrow(/already exists/)
    expect(() => executeSessionCopy(plan, { overwrite: true })).not.toThrow()
  })

  it('leaves the source in place — a copy is never a rename', () => {
    // A rename keeps the inode, so a still-running claude would follow the file
    // and both tabs would append to one transcript.
    const plan = planSessionCopy({ sessionId: SESSION, sourceJsonl, targetProjectsRoot: targetProjects })!
    executeSessionCopy(plan)
    expect(existsSync(sourceJsonl)).toBe(true)
  })

  it('marks a relocation when the recorded cwd is gone', () => {
    const dead = join(repo, '.claude', 'worktrees', 'gone')
    const slugDir = join(sourceProjects, pathToProjectSlug(dead))
    mkdirSync(slugDir, { recursive: true })
    const wtJsonl = join(slugDir, `${SESSION}.jsonl`)
    writeFileSync(wtJsonl, msg(dead) + '\n')

    const plan = planSessionCopy({ sessionId: SESSION, sourceJsonl: wtJsonl, targetProjectsRoot: targetProjects })!
    expect(plan.target.reason).toBe('repo-root')
    expect(plan.target.dir).toBe(repo)
    expect(plan.relocated).toBe(true)
  })
})

describe('removeSourceSession', () => {
  let projects: string
  let jsonl: string
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'cctabs-rm-'))
    jsonl = join(projects, `${SESSION}.jsonl`)
    writeFileSync(jsonl, msg('/tmp') + '\n')
  })
  afterEach(() => { rmSync(projects, { recursive: true, force: true }) })

  it('removes the transcript and its sidecar', () => {
    const sidecar = sidecarDirFor(jsonl)
    mkdirSync(sidecar, { recursive: true })
    writeFileSync(join(sidecar, 'a'), 'a')

    const r = removeSourceSession(jsonl, SESSION)
    expect(r).toEqual({ removedJsonl: true, removedSidecar: true, sweptStub: false })
    expect(existsSync(jsonl)).toBe(false)
    expect(existsSync(sidecar)).toBe(false)
  })
})

describe('sweepMetadataStub', () => {
  let projects: string
  let jsonl: string
  beforeEach(() => {
    projects = mkdtempSync(join(tmpdir(), 'cctabs-sweep-'))
    jsonl = join(projects, `${SESSION}.jsonl`)
  })
  afterEach(() => { rmSync(projects, { recursive: true, force: true }) })

  it('removes a trailer that reappeared after the move', () => {
    writeFileSync(jsonl, JSON.stringify({ type: 'custom-title', customTitle: 'x', sessionId: SESSION }) + '\n')
    expect(sweepMetadataStub(jsonl, SESSION)).toBe(true)
    expect(existsSync(jsonl)).toBe(false)
  })

  it('leaves a real transcript alone', () => {
    writeFileSync(jsonl, msg('/tmp') + '\n')
    expect(sweepMetadataStub(jsonl, SESSION)).toBe(false)
    expect(existsSync(jsonl)).toBe(true)
  })

  it('is a no-op when nothing reappeared', () => {
    expect(sweepMetadataStub(jsonl, SESSION)).toBe(false)
  })
})

describe('archiveProjectDir', () => {
  let configRoot: string
  let projectDir: string
  beforeEach(() => {
    configRoot = mkdtempSync(join(tmpdir(), 'cctabs-cfg-'))
    projectDir = join(configRoot, 'projects', '-Users-x-repo--claude-worktrees-gone')
    mkdirSync(projectDir, { recursive: true })
  })
  afterEach(() => { rmSync(configRoot, { recursive: true, force: true }) })

  it('moves the dir out of projects/ entirely, not just renames it', () => {
    // Renaming in place would keep shadowing: resolution matches the
    // customTitle inside the transcripts, not the directory name, and a
    // worktree-named project dir is itself read as proof the worktree exists.
    const archived = archiveProjectDir(projectDir, configRoot, '20260820-101500')!
    expect(existsSync(projectDir)).toBe(false)
    expect(archived.startsWith(join(configRoot, ARCHIVE_DIR_NAME))).toBe(true)
    expect(readdirSync(join(configRoot, 'projects'))).toEqual([])
  })

  it('does not collide when archiving twice in the same second', () => {
    const first = archiveProjectDir(projectDir, configRoot, 'stamp')!
    mkdirSync(projectDir, { recursive: true })
    const second = archiveProjectDir(projectDir, configRoot, 'stamp')!
    expect(second).not.toBe(first)
    expect(basename(second)).toMatch(/-stamp-2$/)
  })

  it('returns null when there is nothing there', () => {
    expect(archiveProjectDir(join(configRoot, 'projects', 'nope'), configRoot, 'stamp')).toBeNull()
  })
})

describe('projectDirHasTranscripts', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cctabs-pd-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('is false for an emptied dir, true once a transcript is there', () => {
    expect(projectDirHasTranscripts(dir)).toBe(false)
    writeFileSync(join(dir, 'x.jsonl'), '')
    expect(projectDirHasTranscripts(dir)).toBe(true)
  })

  it('ignores a leftover sidecar directory', () => {
    mkdirSync(join(dir, SESSION), { recursive: true })
    expect(projectDirHasTranscripts(dir)).toBe(false)
  })
})
