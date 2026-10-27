import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CONFIG_PATH } from './config.js'

/**
 * Adding another Claude account as a backend preset — `cctabs account add`.
 *
 * An account is just its own CLAUDE_CONFIG_DIR, signed in once with Claude's
 * normal login. Claude Code keys its macOS Keychain entry by that dir
 * (`Claude Code-credentials-<sha256(dir)[0:8]>`, read from 2.1.311's own
 * source on 2026-10-27), so a login there does not touch yours, and the two run
 * side by side. No token is minted, pasted or stored: the preset holds a path.
 *
 * Older advice (and older cctabs docs) said the Keychain entry was global and
 * minted a `claude setup-token` for each account instead. Presets written that
 * way keep working: CLAUDE_CODE_OAUTH_TOKEN still wins over the Keychain.
 */

/** Builtin preset names an account must not shadow. Kept short on purpose. */
const RESERVED = new Set(['anthropic', 'default'])

/** A preset name is a TOML table key and part of a directory name. */
export function accountNameProblem(name: string | undefined): string | null {
  if (!name) return 'An account name is required, e.g. `cctabs account add client-x`.'
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    return `"${name}" can't be an account name: use lower-case letters, digits and dashes (e.g. client-x).`
  }
  if (RESERVED.has(name)) return `"${name}" is the name of your own account's preset; pick another.`
  return null
}

/** Where the account's own Claude config dir goes: ~/.claude-<name>. */
export function defaultAccountConfigDir(name: string): string {
  return join(homedir(), `.claude-${name}`)
}

/** Is there already a `[backends.<name>]` table in this config text? */
export function hasPresetSection(configText: string, name: string): boolean {
  return configText.split('\n').some((l) => l.trim() === `[backends.${name}]`)
}

/** The preset's TOML table: a name and a config dir, nothing secret. */
export function accountPresetBlock(name: string, configDir: string): string {
  return [
    `[backends.${name}]`,
    `description = "Claude account: ${name} (cctabs account add)"`,
    `env_CLAUDE_CONFIG_DIR = "${configDir}"`,
    '',
  ].join('\n')
}

/** Config text with the block appended after a blank line. */
export function appendPreset(configText: string, block: string): string {
  if (!configText) return block
  const base = configText.endsWith('\n') ? configText : configText + '\n'
  return `${base}\n${block}`
}

/** Write the preset into the config file, never over one of the same name. */
export function writeAccountPreset(name: string, configDir: string, path = CONFIG_PATH): void {
  const text = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (hasPresetSection(text, name)) throw new Error(`[backends.${name}] already exists in ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, appendPreset(text, accountPresetBlock(name, configDir)))
}

/**
 * Is this preset another Claude account rather than another model provider?
 * It has its own config dir and still talks to Anthropic.
 */
export function isAccountPreset(env: Record<string, string>): boolean {
  return !!env.CLAUDE_CONFIG_DIR && !env.ANTHROPIC_BASE_URL
}

/** What `claude auth status --json` says about a login, as far as we use it. */
export interface AuthStatus {
  loggedIn: boolean
  email?: string
  authMethod?: string
}

export function parseAuthStatus(stdout: string): AuthStatus | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>
    return {
      loggedIn: d.loggedIn === true,
      email: typeof d.email === 'string' ? d.email : undefined,
      authMethod: typeof d.authMethod === 'string' ? d.authMethod : undefined,
    }
  } catch {
    return null
  }
}
