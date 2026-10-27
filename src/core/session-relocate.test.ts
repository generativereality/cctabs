import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { findTranscriptInProjects, planResumeRelocation } from './session-relocate.js'
import { pathToProjectSlug } from './session.js'

const SESSION = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function msg(cwd: string): string {
  return JSON.stringify({ type: 'user', cwd, sessionId: SESSION, message: { role: 'user', content: 'hi' } })
}

describe('planResumeRelocation', () => {
  let root: string
  let projects: string
  let repo: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cctabs-relocate-'))
    projects = join(root, 'projects')
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  /** A transcript filed under `cwd`'s slug, recording `cwd`, with a sidecar. */
  function fileUnder(cwd: string, sidecarFiles = 0): string {
    const pd = join(projects, pathToProjectSlug(cwd))
    mkdirSync(pd, { recursive: true })
    const f = join(pd, `${SESSION}.jsonl`)
    writeFileSync(f, msg(cwd) + '\n')
    if (sidecarFiles) {
      mkdirSync(join(pd, SESSION, 'subagents'), { recursive: true })
      for (let i = 0; i < sidecarFiles; i++) writeFileSync(join(pd, SESSION, 'subagents', `a${i}.jsonl`), '{}\n')
    }
    return f
  }

  // The recipe the skill used to give, as one decision: the worktree is gone,
  // so the session moves to the repo's folder, sidecar and all.
  it('moves a session out of a deleted worktree, with its sidecar', () => {
    const gone = join(repo, '.claude', 'worktrees', 'feature')
    const src = fileUnder(gone, 3)
    const d = planResumeRelocation({ sessionId: SESSION, dir: repo, projectsRoot: projects })
    expect(d.kind).toBe('relocate')
    if (d.kind !== 'relocate') return
    expect(d.plan.sourceJsonl).toBe(src)
    expect(d.plan.targetJsonl).toBe(join(projects, pathToProjectSlug(repo), `${SESSION}.jsonl`))
    expect(d.plan.sidecarFileCount).toBe(3)
  })

  it('leaves a session alone when its worktree still exists', () => {
    const live = join(repo, '.claude', 'worktrees', 'feature')
    mkdirSync(live, { recursive: true })
    fileUnder(live)
    expect(planResumeRelocation({ sessionId: SESSION, dir: repo, projectsRoot: projects })).toEqual({ kind: 'none', reason: 'cwd-alive' })
  })

  it('does nothing when the session is already filed here', () => {
    fileUnder(repo)
    expect(planResumeRelocation({ sessionId: SESSION, dir: repo, projectsRoot: projects })).toEqual({ kind: 'none', reason: 'already-here' })
  })

  it('does nothing for an id it cannot find', () => {
    expect(planResumeRelocation({ sessionId: SESSION, dir: repo, projectsRoot: projects })).toEqual({ kind: 'none', reason: 'not-found' })
  })

  // A closing Claude writes a metadata-only trailer back to the old path; it is
  // not the session and must not be what gets moved.
  it('ignores a metadata-only trailer', () => {
    const pd = join(projects, pathToProjectSlug(join(root, 'gone')))
    mkdirSync(pd, { recursive: true })
    writeFileSync(join(pd, `${SESSION}.jsonl`), JSON.stringify({ type: 'custom-title', customTitle: 'x', sessionId: SESSION }) + '\n')
    expect(findTranscriptInProjects(projects, SESSION)).toBeNull()
  })
})
