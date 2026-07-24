import { describe, it, expect } from 'bun:test'
import { homedir } from 'os'
import { parseManifest } from './manifest.js'

describe('parseManifest', () => {
  it('accepts a plain array of entries', () => {
    const out = parseManifest(JSON.stringify([
      { name: 'alpha', dir: '/tmp/alpha', session_id: 'abc123' },
      { name: 'beta', dir: '/tmp/beta' },
    ]))
    expect(out).toEqual([
      { name: 'alpha', dir: '/tmp/alpha', sessionId: 'abc123' },
      { name: 'beta', dir: '/tmp/beta', sessionId: undefined },
    ])
  })

  it('accepts {sessions: [...]}', () => {
    const out = parseManifest(JSON.stringify({ sessions: [{ name: 'alpha', dir: '/tmp/alpha' }] }))
    expect(out.map((e) => e.name)).toEqual(['alpha'])
  })

  it('accepts `cctabs sessions --json` output', () => {
    const out = parseManifest(JSON.stringify({
      workspaces: [
        { name: 'ws1', sessions: [{ name: 'alpha', dir: '/tmp/alpha' }] },
        { name: 'ws2', sessions: [{ name: 'beta', cwd: '/tmp/beta' }] },
      ],
    }))
    expect(out).toEqual([
      { name: 'alpha', dir: '/tmp/alpha', sessionId: undefined },
      { name: 'beta', dir: '/tmp/beta', sessionId: undefined },
    ])
  })

  it('preserves manifest order — restore rebuilds the tab bar from it', () => {
    const out = parseManifest(JSON.stringify([
      { name: 'c', dir: '/tmp/c' },
      { name: 'a', dir: '/tmp/a' },
      { name: 'b', dir: '/tmp/b' },
    ]))
    expect(out.map((e) => e.name)).toEqual(['c', 'a', 'b'])
  })

  it('takes cwd as an alias for dir', () => {
    expect(parseManifest(JSON.stringify([{ name: 'alpha', cwd: '/tmp/alpha' }]))[0].dir)
      .toBe('/tmp/alpha')
  })

  it('expands ~ and resolves relative paths', () => {
    const out = parseManifest(JSON.stringify([{ name: 'alpha', dir: '~/projects/x' }]))
    expect(out[0].dir).toBe(`${homedir()}/projects/x`)
  })

  it('skips entries missing a name or a directory rather than failing the file', () => {
    const out = parseManifest(JSON.stringify([
      { name: 'alpha', dir: '/tmp/alpha' },
      { name: 'no-dir' },
      { dir: '/tmp/no-name' },
      'not an object',
      null,
    ]))
    expect(out.map((e) => e.name)).toEqual(['alpha'])
  })

  it('ignores a non-string session_id', () => {
    expect(parseManifest(JSON.stringify([{ name: 'a', dir: '/tmp/a', session_id: 42 }]))[0].sessionId)
      .toBeUndefined()
  })

  it('returns nothing for a shape it does not recognise', () => {
    expect(parseManifest(JSON.stringify({ tabs: [{ name: 'a', dir: '/tmp/a' }] }))).toEqual([])
  })

  it('throws a clear error on invalid JSON', () => {
    expect(() => parseManifest('{not json')).toThrow(/Manifest is not valid JSON/)
  })
})
