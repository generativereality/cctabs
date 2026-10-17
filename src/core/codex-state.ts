import { sameCodexCwd } from './codex-sessions.js'
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface CodexIdentity { id: string; name: string; cwd: string; tabId?: string; pid?: number; updatedAt?: string }
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
export function codexStateDir(): string { return process.env.CCTABS_CODEX_STATE_DIR || join(homedir(), '.config', 'cctabs', 'codex-sessions') }
export function rememberCodex(identity: CodexIdentity, root = codexStateDir()): void {
  if (!uuid.test(identity.id)) throw new Error('Invalid Codex session id')
  identity = { ...identity, id: identity.id.toLowerCase() }
  mkdirSync(root, { recursive: true })
  const file = join(root, identity.id + '.json'), tmp = file + `.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...identity, updatedAt: new Date().toISOString() }) + '\n')
  renameSync(tmp, file)
}
export function codexIdentities(root = codexStateDir()): CodexIdentity[] {
  try { return readdirSync(root).filter((f) => f.endsWith('.json')).flatMap((f) => {
    try { const r = JSON.parse(readFileSync(join(root, f), 'utf8')); return uuid.test(r.id) && typeof r.name === 'string' && typeof r.cwd === 'string' ? [r] : [] } catch { return [] }
  }) } catch { return [] }
}
export function namedCodex(name: string, cwd?: string, root = codexStateDir()): CodexIdentity | undefined {
  const hits = codexIdentities(root).filter((r) => r.name === name && (!cwd || sameCodexCwd(r.cwd, cwd)))
  if (hits.length > 1) throw new Error(`Multiple Codex sessions named "${name}"; pass --session <id>`)
  return hits[0]
}
