import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * The Tabby plugin's control token: a random secret the plugin writes at startup to a file
 * only this OS user can read, and requires on every API call but /api/health. Same path as
 * the plugin's `controlTokenPath()`; `CCTABS_CONTROL_TOKEN_FILE` overrides it on both sides.
 */
export function controlTokenPath(): string {
  return process.env.CCTABS_CONTROL_TOKEN_FILE ?? join(homedir(), '.cctabs', 'control-token')
}

/**
 * Read fresh on every call: the plugin mints a new token each time Tabby starts, and a
 * long-running cctabs (`watch`) outlives a Tabby restart. Null when there is no file — an
 * older plugin that wants no token, or a plugin that could not write one.
 */
export function readControlToken(): string | null {
  try {
    const token = readFileSync(controlTokenPath(), 'utf-8').trim()
    return token || null
  } catch {
    return null
  }
}

/** Headers for a fetch() to the plugin. */
export function authHeaders(): Record<string, string> {
  const token = readControlToken()
  return token ? { authorization: `Bearer ${token}` } : {}
}

/**
 * curl arguments plus stdin that send the token without putting it on the command line,
 * where every process on the machine could read it from `ps`. curl reads `--config -` from
 * stdin; the header goes there.
 */
export function curlAuth(): { args: string[]; input?: string } {
  const token = readControlToken()
  if (!token) return { args: [] }
  return { args: ['--config', '-'], input: `header = "Authorization: Bearer ${token}"\n` }
}
