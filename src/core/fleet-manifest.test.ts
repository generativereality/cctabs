import { describe, it, expect } from 'bun:test'
import { buildManifest, withoutInvalid, type ManifestOptions } from './fleet-manifest.js'
import type { SessionRow } from './session-rows.js'

const S1 = '11111111-1111-4111-8111-111111111111'
const S2 = '22222222-2222-4222-8222-222222222222'
const S3 = '33333333-3333-4333-8333-333333333333'
const SELF = '99999999-9999-4999-8999-999999999999'

function row(name: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    block_id: `b-${name}`,
    tab_id: `t-${name}`,
    name,
    cwd: `/work/${name}`,
    current: false,
    status: 'idle',
    last_line: '',
    session_id: null,
    session_lookup: 'not-found',
    ...over,
  }
}

function opts(over: Partial<ManifestOptions> = {}): ManifestOptions {
  return {
    selfSessionId: SELF,
    dirExists: () => true,
    transcriptExists: () => true,
    liveSessionPids: new Map(),
    ...over,
  }
}

describe('buildManifest', () => {
  it('emits what restore --manifest reads, carrying origin, mode and colour', () => {
    const r = buildManifest(
      [row('alpha', { session_id: S1, session_lookup: 'found', backend: 'work', config_dir: '/cfg', permission_mode: 'plan', color: '#0275d8' })],
      opts(),
    )
    expect(r.entries).toEqual([
      { name: 'alpha', dir: '/work/alpha', session_id: S1, backend: 'work', config_dir: '/cfg', permission_mode: 'plan', color: '#0275d8' },
    ])
    expect(r.problems).toEqual([])
  })

  it('leaves the calling session out, by session id or by its Claude pid', () => {
    const r = buildManifest(
      [
        row('me', { session_id: SELF, session_lookup: 'found' }),
        row('me-by-pid', { session_id: S2, session_lookup: 'found', claude_pid: 42 }),
        row('other', { session_id: S1, session_lookup: 'found' }),
      ],
      opts({ selfClaudePid: 42 }),
    )
    expect(r.entries.map((e) => e.name)).toEqual(['other'])
    expect(r.excluded.map((e) => e.name)).toEqual(['me', 'me-by-pid'])
  })

  it('keeps the caller in with includeSelf', () => {
    const r = buildManifest([row('me', { session_id: SELF, session_lookup: 'found' })], opts({ includeSelf: true }))
    expect(r.entries).toHaveLength(1)
  })

  it('settles a session-id collision in favour of the tab whose live Claude runs it', () => {
    // The measured case: a leftover tab still titled with the session's old
    // name resolves by title to the same id another tab is running.
    const r = buildManifest(
      [
        row('old-name', { session_id: S1, session_lookup: 'found' }),
        row('new-name', { session_id: S1, session_lookup: 'found', session_source: 'argv', claude_pid: 7 }),
      ],
      opts({ liveSessionPids: new Map([[S1, [7]]]) }),
    )
    expect(r.entries.map((e) => e.name)).toEqual(['new-name'])
    expect(r.problems).toEqual([expect.objectContaining({ name: 'old-name', code: 'duplicate-session-dropped', severity: 'warning' })])
  })

  it('fails loudly on a collision nothing can settle', () => {
    const r = buildManifest(
      [row('a', { session_id: S1, session_lookup: 'found' }), row('b', { session_id: S1, session_lookup: 'found' })],
      opts(),
    )
    expect(r.problems.filter((p) => p.code === 'duplicate-session').map((p) => p.name)).toEqual(['a', 'b'])
    expect(r.problems.every((p) => p.severity === 'error')).toBe(true)
    expect(withoutInvalid(r)).toEqual([])
  })

  it('does not let two live processes on one id "settle" it', () => {
    const r = buildManifest(
      [
        row('a', { session_id: S1, session_lookup: 'found', claude_pid: 1 }),
        row('b', { session_id: S1, session_lookup: 'found', claude_pid: 2 }),
      ],
      opts({ liveSessionPids: new Map([[S1, [1, 2]]]) }),
    )
    expect(r.problems.filter((p) => p.severity === 'error')).toHaveLength(2)
  })

  it('refuses a missing dir unless told where to repoint it', () => {
    const gone = (p: string) => p !== '/work/gone'
    const refused = buildManifest([row('gone', { session_id: S1, session_lookup: 'found' })], opts({ dirExists: gone }))
    expect(refused.problems).toEqual([expect.objectContaining({ code: 'missing-dir', severity: 'error' })])

    const repointed = buildManifest(
      [row('gone', { session_id: S1, session_lookup: 'found' })],
      opts({ dirExists: gone, repointMissingDirs: '/work' }),
    )
    expect(repointed.entries[0].dir).toBe('/work')
    expect(repointed.problems).toEqual([expect.objectContaining({ code: 'repointed', severity: 'warning' })])
  })

  it('refuses an id with no transcript in any config dir', () => {
    const r = buildManifest(
      [row('ghost', { session_id: S3, session_lookup: 'found' })],
      opts({ transcriptExists: (id) => id !== S3 }),
    )
    expect(r.problems).toEqual([expect.objectContaining({ code: 'no-transcript', severity: 'error' })])
  })

  it('keeps a tab with no session but says its context cannot come back', () => {
    const r = buildManifest([row('fresh')], opts())
    expect(r.entries).toEqual([{ name: 'fresh', dir: '/work/fresh' }])
    expect(r.problems).toEqual([expect.objectContaining({ code: 'no-session', severity: 'warning' })])
  })

  // Restore resolves a manifest entry by name alone, so two same-named tabs
  // come back 'ambiguous' — neither restored. Restart must not stop them first.
  it('rejects two tabs sharing a name, so restart leaves both running', () => {
    const r = buildManifest(
      [row('twin', { session_id: S1, session_lookup: 'found' }), row('twin', { session_id: S2, session_lookup: 'found' })],
      opts(),
    )
    const dup = r.problems.filter((p) => p.code === 'duplicate-name')
    expect(dup).toHaveLength(2)
    expect(dup.every((p) => p.severity === 'error')).toBe(true)
    expect(withoutInvalid(r)).toEqual([])
  })

  // The argv fallback exists for a renamed worktree, whose transcript sits
  // under the OLD slug; resuming from the new dir would not find it.
  it('rejects an argv-recovered session whose transcript is not under its dir', () => {
    const r = buildManifest(
      [row('moved', { session_id: S1, session_lookup: 'not-found', session_source: 'argv' })],
      opts({ transcriptInDir: () => false }),
    )
    expect(r.problems).toEqual([expect.objectContaining({ code: 'transcript-elsewhere', severity: 'error' })])
  })

  it('accepts an argv-recovered session whose transcript is under its dir', () => {
    const r = buildManifest(
      [row('here', { session_id: S1, session_lookup: 'not-found', session_source: 'argv' })],
      opts({ transcriptInDir: () => true }),
    )
    expect(r.problems.filter((p) => p.severity === 'error')).toEqual([])
  })

  it('does not apply the slug check to a session found by its transcript', () => {
    const r = buildManifest(
      [row('found', { session_id: S1, session_lookup: 'found', session_source: 'transcript' })],
      opts({ transcriptInDir: () => false }),
    )
    expect(r.problems.filter((p) => p.code === 'transcript-elsewhere')).toEqual([])
  })
})
