import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CONFIG_PATH } from './config.js'

/**
 * Adding another Claude account as a backend preset — `cctabs account add`.
 *
 * Why a token and not a second `/login`: macOS keeps Claude Code's OAuth login
 * in ONE Keychain entry per OS user, not per CLAUDE_CONFIG_DIR, so two profiles
 * that each `/login` fight over it and the latest login wins for both. A
 * long-lived token from `claude setup-token`, passed as CLAUDE_CODE_OAUTH_TOKEN,
 * is honoured before the Keychain, so a tab with it runs as the other account
 * beside your own sessions.
 *
 * This used to be a fifteen-line recipe in the skill — sign in elsewhere, mint,
 * paste the token into config.toml, chmod it, sign back in as yourself — and an
 * agent following it handled a live credential in its own shell. The command
 * keeps the token between the person and the config file: it is pasted into a
 * hidden prompt, written straight to disk at 0600, and never printed.
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

/**
 * `claude setup-token` prints an `sk-ant-oat…` token. A paste can carry the
 * terminal's line wrapping and surrounding whitespace, so both are removed;
 * anything else that doesn't look like a token is refused rather than stored.
 */
export function normaliseToken(raw: string): string | null {
  const token = raw.replace(/\s+/g, '')
  return /^sk-ant-oat[0-9A-Za-z_-]{20,}$/.test(token) ? token : null
}

/** Is there already a `[backends.<name>]` table in this config text? */
export function hasPresetSection(configText: string, name: string): boolean {
  return configText.split('\n').some((l) => l.trim() === `[backends.${name}]`)
}

/** The preset's TOML table. The token is the only secret in it. */
export function accountPresetBlock(name: string, token: string, configDir: string): string {
  return [
    `[backends.${name}]`,
    `description = "Claude account: ${name} (cctabs account add)"`,
    `env_CLAUDE_CODE_OAUTH_TOKEN = "${token}"`,
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

/**
 * Write the preset into the config file and make the file owner-only. The file
 * holds a live credential from here on, so the mode is set even when it was
 * already there with a looser one.
 */
export function writeAccountPreset(name: string, token: string, configDir: string, path = CONFIG_PATH): void {
  const text = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  if (hasPresetSection(text, name)) throw new Error(`[backends.${name}] already exists in ${path}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, appendPreset(text, accountPresetBlock(name, token, configDir)), { mode: 0o600 })
  chmodSync(path, 0o600)
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

/**
 * Did adding the account cost you your own login? `before` is read before the
 * sign-in, `after` once the token is stored. Unknown either side is no evidence.
 */
export function ownLoginChanged(before: AuthStatus | null, after: AuthStatus | null): boolean {
  if (!before || !after || !before.loggedIn) return false
  if (!after.loggedIn) return true
  return !!before.email && !!after.email && before.email !== after.email
}
