import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

/**
 * Where the control token lives. The CLI reads the same path (src/core/control-token.ts);
 * `CCTABS_CONTROL_TOKEN_FILE` overrides it on both sides.
 */
export function controlTokenPath (): string {
  return process.env.CCTABS_CONTROL_TOKEN_FILE ?? join(homedir(), '.cctabs', 'control-token')
}

/**
 * Mint a fresh token and write it where the CLI will look, readable by this OS user only.
 * A new one every time Tabby starts, so a token copied out of the file stops working at
 * the next restart. Written to a temporary file and renamed into place, so a CLI never
 * reads a half-written token.
 */
export function mintControlToken (): string {
  const token = randomBytes(32).toString('hex')
  const path = controlTokenPath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, token + '\n', { mode: 0o600 })
  // The mode argument is masked by the umask; make sure of it.
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
  return token
}
