import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  accountNameProblem,
  accountPresetBlock,
  appendPreset,
  hasPresetSection,
  normaliseToken,
  ownLoginChanged,
  parseAuthStatus,
  writeAccountPreset,
} from './account.js'

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)

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

describe('normaliseToken', () => {
  // A paste out of a terminal carries its line wrapping.
  it('joins a wrapped paste', () => {
    expect(normaliseToken(`  ${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}\n`)).toBe(TOKEN)
  })

  it('refuses anything that is not a setup-token', () => {
    expect(normaliseToken('sk-ant-api03-' + 'a'.repeat(40))).toBeNull()
    expect(normaliseToken('hello')).toBeNull()
  })
})

describe('preset text', () => {
  it('writes the env the backend loader reads', () => {
    const block = accountPresetBlock('client-x', TOKEN, '/Users/me/.claude-client-x')
    expect(block).toContain('[backends.client-x]')
    expect(block).toContain(`env_CLAUDE_CODE_OAUTH_TOKEN = "${TOKEN}"`)
    expect(block).toContain('env_CLAUDE_CONFIG_DIR = "/Users/me/.claude-client-x"')
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

  // The file holds a live credential from here on: a looser mode it had before
  // is tightened, not kept.
  it('appends the preset and leaves the file owner-only', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, '[claude]\nflags = []\n', { mode: 0o644 })
    writeAccountPreset('client-x', TOKEN, '/tmp/c', path)
    expect(readFileSync(path, 'utf-8')).toContain('[backends.client-x]')
    expect(readFileSync(path, 'utf-8')).toStartWith('[claude]\n')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('never overwrites a preset of the same name', () => {
    const path = join(dir, 'config.toml')
    writeAccountPreset('client-x', TOKEN, '/tmp/c', path)
    expect(() => writeAccountPreset('client-x', TOKEN, '/tmp/c', path)).toThrow('already exists')
  })
})

describe('ownLoginChanged', () => {
  const me = { loggedIn: true, email: 'me@x.io' }

  it('notices the sign-in replaced your own login', () => {
    expect(ownLoginChanged(me, { loggedIn: true, email: 'client@x.io' })).toBe(true)
    expect(ownLoginChanged(me, { loggedIn: false })).toBe(true)
  })

  it('stays quiet when nothing changed or nothing is known', () => {
    expect(ownLoginChanged(me, me)).toBe(false)
    expect(ownLoginChanged(null, me)).toBe(false)
    expect(ownLoginChanged({ loggedIn: false }, { loggedIn: false })).toBe(false)
  })

  it('reads claude auth status --json', () => {
    expect(parseAuthStatus('{"loggedIn":true,"email":"me@x.io","authMethod":"claude.ai"}')).toEqual({ loggedIn: true, email: 'me@x.io', authMethod: 'claude.ai' })
    expect(parseAuthStatus('not json')).toBeNull()
  })
})
