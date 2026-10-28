import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { sessionDirFromTranscript, nestedOrSame } from './session-dir.js'

let root: string
const dir = (...p: string[]) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); return d }
function transcript(...cwds: string[]): string {
  const f = join(root, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  writeFileSync(f, cwds.map((cwd, i) => JSON.stringify({ type: 'user', cwd, timestamp: `2026-10-2${i}T00:00:00Z` })).join('\n') + '\n')
  return f
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'session-dir-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('sessionDirFromTranscript', () => {
  it('overrules a tab sitting in an unrelated repo, and says what it overruled', () => {
    // Measured: a notes-vault conversation snapshotted with another repo's worktree.
    const vault = dir('Notes Vault')
    const other = dir('repo', '.claude', 'worktrees', 'w37')
    expect(sessionDirFromTranscript(transcript(vault), other)).toEqual({ dir: vault, overruled: other })
  })

  it('keeps the proposed dir when it is the same tree: repo root of a worktree, or a subdirectory', () => {
    const repo = dir('repo')
    const wt = dir('repo', '.claude', 'worktrees', 'snyk')
    const sub = dir('repo', '.claude', 'worktrees', 'snyk', 'infra')
    expect(sessionDirFromTranscript(transcript(wt), repo)).toEqual({ dir: repo })
    expect(sessionDirFromTranscript(transcript(wt), sub)).toEqual({ dir: sub })
    expect(sessionDirFromTranscript(transcript(wt), wt)).toEqual({ dir: wt })
  })

  it('follows a session that moved: the LAST recorded cwd that still exists', () => {
    const a = dir('repo', '.claude', 'worktrees', 'a')
    const b = dir('repo', '.claude', 'worktrees', 'b')
    expect(sessionDirFromTranscript(transcript(a, b), b)).toEqual({ dir: b })
    expect(sessionDirFromTranscript(transcript(a, b), dir('elsewhere'))).toEqual({ dir: b, overruled: join(root, 'elsewhere') })
  })

  it('keeps the proposed dir when the transcript records nothing usable', () => {
    const tab = dir('tab')
    expect(sessionDirFromTranscript(undefined, tab)).toEqual({ dir: tab })
    expect(sessionDirFromTranscript(transcript(join(root, 'gone')), tab)).toEqual({ dir: tab })
    expect(sessionDirFromTranscript(undefined, undefined)).toBeNull()
  })

  it('takes the recorded dir when nothing was proposed', () => {
    const vault = dir('vault')
    expect(sessionDirFromTranscript(transcript(vault), undefined)).toEqual({ dir: vault })
  })
})

describe('nestedOrSame', () => {
  it('is path-segment aware', () => {
    expect(nestedOrSame('/a/b', '/a/b/c')).toBe(true)
    expect(nestedOrSame('/a/b/c', '/a/b')).toBe(true)
    expect(nestedOrSame('/a/b', '/a/bc')).toBe(false)
    expect(nestedOrSame('/a/b', '/x')).toBe(false)
  })
})
