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
      { name: 'alpha', dir: '/tmp/alpha', sessionId: 'abc123', backend: undefined, configDir: undefined },
      { name: 'beta', dir: '/tmp/beta', sessionId: undefined, backend: undefined, configDir: undefined },
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
      { name: 'alpha', dir: '/tmp/alpha', sessionId: undefined, backend: undefined, configDir: undefined },
      { name: 'beta', dir: '/tmp/beta', sessionId: undefined, backend: undefined, configDir: undefined },
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

  it('round-trips the backend and config dir a `sessions --json` entry carries', () => {
    // Shape emitted by `cctabs sessions --json` for a session living in a
    // second Claude account's config dir.
    const out = parseManifest(JSON.stringify({
      workspaces: [{
        sessions: [{
          name: 'gapminder-login',
          cwd: '/Users/motin/Dev/Projects/Gapminder',
          session_id: 'c1ae54cf-728b-40e5-a4a1-c34ac017968b',
          backend: 'gapminder',
          config_dir: '/Users/motin/.claude-gapminder',
        }],
      }],
    }))
    expect(out).toEqual([{
      name: 'gapminder-login',
      dir: '/Users/motin/Dev/Projects/Gapminder',
      sessionId: 'c1ae54cf-728b-40e5-a4a1-c34ac017968b',
      backend: 'gapminder',
      configDir: '/Users/motin/.claude-gapminder',
    }])
  })

  it('leaves backend and config dir unset when the manifest omits them', () => {
    // Older manifests, and default-account sessions. Restore infers the origin
    // from wherever it finds the session, so these still restore correctly.
    const [entry] = parseManifest(JSON.stringify([{ name: 'a', dir: '/tmp/a', session_id: 'abc' }]))
    expect(entry.backend).toBeUndefined()
    expect(entry.configDir).toBeUndefined()
  })

  it('expands ~ in a config dir', () => {
    const [entry] = parseManifest(JSON.stringify([
      { name: 'a', dir: '/tmp/a', config_dir: '~/.claude-gapminder' },
    ]))
    expect(entry.configDir).toBe(`${homedir()}/.claude-gapminder`)
  })

  it('ignores a non-string backend', () => {
    const [entry] = parseManifest(JSON.stringify([{ name: 'a', dir: '/tmp/a', backend: 7 }]))
    expect(entry.backend).toBeUndefined()
  })

  it('throws a clear error on invalid JSON', () => {
    expect(() => parseManifest('{not json')).toThrow(/Manifest is not valid JSON/)
  })
})

describe('permission mode round-trip', () => {
  it('carries a recorded mode through so restore can put the tab back as it was', () => {
    const [e] = parseManifest(JSON.stringify([
      { name: 'a', dir: '/tmp/a', permission_mode: 'plan' },
    ]))
    expect(e.permissionMode).toBe('plan')
  })

  it('drops a mode `claude --permission-mode` would reject rather than failing the launch', () => {
    // `default` occurs in real transcripts but is not an accepted flag value.
    for (const bad of ['default', 'dontAsk', 'PLAN', '', 42, null]) {
      const [e] = parseManifest(JSON.stringify([
        { name: 'a', dir: '/tmp/a', permission_mode: bad },
      ]))
      expect(e.permissionMode).toBeUndefined()
    }
  })

  it('leaves the mode unset for a manifest written before the field existed', () => {
    const [e] = parseManifest(JSON.stringify([{ name: 'a', dir: '/tmp/a' }]))
    expect(e.permissionMode).toBeUndefined()
  })
})
