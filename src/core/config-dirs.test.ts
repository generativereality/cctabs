import { describe, it, expect } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  scopeToDirs,
  originOf,
  DEFAULT_CONFIG_ROOT,
  type ClaudeConfigDir,
} from './config-dirs.js'
import { launchEnvFor } from './backends.js'

describe('scopeToDirs', () => {
  it('treats a bare projects root as one config dir', () => {
    expect(scopeToDirs('/tmp/fake/projects')).toEqual([
      { root: '/tmp/fake', projectsRoot: '/tmp/fake/projects' },
    ])
  })

  it('passes an explicit list through', () => {
    const dirs: ClaudeConfigDir[] = [
      { root: '/a', projectsRoot: '/a/projects' },
      { root: '/b', projectsRoot: '/b/projects', backend: 'gapminder' },
    ]
    expect(scopeToDirs(dirs)).toBe(dirs)
  })

  it("defaults to the machine's config dirs, starting with ~/.claude", () => {
    const dirs = scopeToDirs(undefined)
    expect(dirs.length).toBeGreaterThan(0)
    expect(dirs[0]).toEqual({
      root: DEFAULT_CONFIG_ROOT,
      projectsRoot: join(homedir(), '.claude', 'projects'),
      backend: undefined,
    })
  })
})

describe('originOf', () => {
  it('reports nothing for the default config dir — it needs no env', () => {
    expect(originOf({ root: DEFAULT_CONFIG_ROOT, projectsRoot: `${DEFAULT_CONFIG_ROOT}/projects` }))
      .toEqual({})
  })

  it('reports the backend and dir for a preset-owned config dir', () => {
    expect(originOf({ root: '/Users/x/.claude-gapminder', projectsRoot: '/p', backend: 'gapminder' }))
      .toEqual({ backend: 'gapminder', configDir: '/Users/x/.claude-gapminder' })
  })

  it('reports the dir even when no preset names it', () => {
    expect(originOf({ root: '/Users/x/.claude-adhoc', projectsRoot: '/p' }))
      .toEqual({ backend: undefined, configDir: '/Users/x/.claude-adhoc' })
  })
})

describe('launchEnvFor', () => {
  it('is a no-op for a default-config-dir session', () => {
    expect(launchEnvFor(undefined, undefined)).toEqual({})
  })

  // The silent-failure case: without CLAUDE_CONFIG_DIR the id simply isn't
  // there and `claude --resume` opens a fresh conversation instead.
  it('carries a bare config dir through when no preset owns it', () => {
    expect(launchEnvFor(undefined, '/Users/x/.claude-adhoc'))
      .toEqual({ env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude-adhoc' } })
  })

  it('uses the full preset env for a known backend', () => {
    const { env } = launchEnvFor('kimi', undefined)
    expect(env?.CCTABS_ACTIVE_BACKEND).toBe('kimi')
    expect(env?.ANTHROPIC_BASE_URL).toBeTruthy()
  })

  it('passes the preset model through so a resume does not land on the wrong one', () => {
    expect(launchEnvFor('kimi', undefined).model).toBe('kimi-k2.6:cloud')
  })

  it('falls back to the discovered config dir when the preset does not set one', () => {
    const { env } = launchEnvFor('kimi', '/Users/x/.claude-other')
    expect(env?.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-other')
  })

  it('treats an unknown backend name as no preset, keeping the config dir', () => {
    expect(launchEnvFor('does-not-exist', '/Users/x/.claude-adhoc'))
      .toEqual({ env: { CLAUDE_CONFIG_DIR: '/Users/x/.claude-adhoc' } })
  })
})
