import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  accountNameProblem,
  accountPresetBlock,
  appendPreset,
  hasPresetSection,
  isAccountPreset,
  parseAuthStatus,
  writeAccountPreset,
} from './account.js'

describe('accountNameProblem', () => {
  it('accepts a plain preset name', () => {
    expect(accountNameProblem('client-x')).toBeNull()
  })

  it('refuses names that would break the TOML table or the directory', () => {
    for (const bad of ['Client X', 'a.b', '-x', 'x/y', '']) expect(accountNameProblem(bad)).not.toBeNull()
    expect(accountNameProblem(undefined)).toContain('required')
  })

  it('refuses the default account\'s own preset name', () => {
    expect(accountNameProblem('anthropic')).toContain('your own account')
  })
})

describe('preset text', () => {
  it('writes the env the backend loader reads', () => {
    const block = accountPresetBlock('client-x', '/Users/me/.claude-client-x')
    expect(block).toContain('[backends.client-x]')
    expect(block).toContain('env_CLAUDE_CONFIG_DIR = "/Users/me/.claude-client-x"')
  })

  // The login lives in the config dir's own Keychain entry, so nothing secret
  // goes into config.toml.
  it('holds no token', () => {
    expect(accountPresetBlock('client-x', '/tmp/c')).not.toContain('TOKEN')
  })

  it('finds an existing table and appends after a blank line', () => {
    expect(hasPresetSection('[claude]\n[backends.client-x]\nx = "1"\n', 'client-x')).toBe(true)
    expect(hasPresetSection('[backends.client-xy]\n', 'client-x')).toBe(false)
    expect(appendPreset('[claude]\nflags = []', 'B\n')).toBe('[claude]\nflags = []\n\nB\n')
  })
})

describe('writeAccountPreset', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cctabs-account-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('appends the preset after what is there', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, '[claude]\nflags = []\n')
    writeAccountPreset('client-x', '/tmp/c', path)
    expect(readFileSync(path, 'utf-8')).toContain('[backends.client-x]')
    expect(readFileSync(path, 'utf-8')).toStartWith('[claude]\n')
  })

  it('never overwrites a preset of the same name', () => {
    const path = join(dir, 'config.toml')
    writeAccountPreset('client-x', '/tmp/c', path)
    expect(() => writeAccountPreset('client-x', '/tmp/c', path)).toThrow('already exists')
  })
})

describe('isAccountPreset', () => {
  it('is a config dir that still talks to Anthropic', () => {
    expect(isAccountPreset({ CLAUDE_CONFIG_DIR: '/tmp/c' })).toBe(true)
    expect(isAccountPreset({ CLAUDE_CONFIG_DIR: '/tmp/c', CLAUDE_CODE_OAUTH_TOKEN: 'x' })).toBe(true)
    expect(isAccountPreset({ ANTHROPIC_BASE_URL: 'http://localhost:11434' })).toBe(false)
    expect(isAccountPreset({})).toBe(false)
  })
})

describe('parseAuthStatus', () => {
  it('reads claude auth status --json', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"me@x.io","authMethod":"claude.ai"}')).toEqual({ loggedIn: true, email: 'me@x.io', authMethod: 'claude.ai' })
    expect(parseAuthStatus('not json')).toBeNull()
  })
})
