import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname, join, basename } from 'path'
import { readCodexSessions, type CodexSession } from './codex-sessions.js'
import type { AssistantTurn } from './transcript.js'

export type HistoryRecord = { type: string; ordinal?: number; timestamp?: string; payload: any }
export function codexHistory(id: string, sessions = readCodexSessions(), seen = new Set<string>()): HistoryRecord[] {
  if (seen.has(id)) throw new Error('Cycle in Codex history ancestry')
  seen.add(id)
  const session = sessions.find((s) => s.id === id)
  if (!session) throw new Error(`Missing Codex rollout ${id}`)
  const own: HistoryRecord[] = readFileSync(session.file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const meta = own.find((r) => r.type === 'session_meta')?.payload
  const base = meta?.history_base
  if (!base?.thread_id) return own
  if (!Number.isSafeInteger(base.end_ordinal_exclusive) || base.end_ordinal_exclusive < 0) throw new Error('Invalid Codex fork boundary')
  const inherited = codexHistory(base.thread_id, sessions, seen).filter((r, index) => {
    const at = r.ordinal ?? index
    return at < base.end_ordinal_exclusive && r.type !== 'session_meta'
  })
  return [...inherited, ...own]
}
export function codexAssistantTurns(id: string, sessions = readCodexSessions()): AssistantTurn[] {
  return codexHistory(id, sessions).flatMap((r) => {
    const p = r.payload
    if (r.type !== 'response_item' || p?.type !== 'message' || p.role !== 'assistant') return []
    const text = (p.content ?? []).filter((c: any) => c.type === 'output_text' || c.type === 'text').map((c: any) => c.text ?? '').join('\n')
    return text ? [{ text, timestamp: r.timestamp }] : []
  })
}
/** Preserve each ancestor separately: Codex's history_base ordinals must stay valid. */
export function codexHistoryFiles(id: string, sessions = readCodexSessions(), seen = new Set<string>()): CodexSession[] {
  if (seen.has(id)) throw new Error('Cycle in Codex history ancestry')
  seen.add(id)
  const s = sessions.find((s) => s.id === id)
  if (!s) throw new Error(`Missing Codex rollout ${id}`)
  const first = JSON.parse(readFileSync(s.file, 'utf8').split('\n')[0]).payload
  return [...(first.history_base?.thread_id ? codexHistoryFiles(first.history_base.thread_id, sessions, seen) : []), s]
}
export function importCodexHistory(files: string[], root: string, force = false): void {
  // Preflight all files before writing any. Never overwrite a different live rollout implicitly.
  const local = readCodexSessions(root)
  const targets = files.map((file) => {
    const text = readFileSync(file, 'utf8'), row = JSON.parse(text.split('\n')[0]), p = row.payload
    const id = p?.session_id ?? p?.id
    if (row.type !== 'session_meta' || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid Codex archive metadata')
    const date = new Date(p.timestamp ?? row.timestamp)
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid Codex timestamp')
    const matches = local.filter((s) => s.id === id)
    const longer = matches.find((s) => readFileSync(s.file, 'utf8').startsWith(text))
    if (longer) return { target: longer.file, text, keep: true }
    if (matches.length > 1) throw new Error(`Multiple local Codex rollouts for ${id}; resolve them before importing`)
    const target = matches[0]?.file ?? join(root, ...date.toISOString().slice(0, 10).split('-'), basename(file))
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : undefined
    // A complete local parent may contain turns after the exported fork. Keep them.
    const keep = existing !== undefined && existing.startsWith(text)
    if (existing !== undefined && !keep && existing !== text && !force) throw new Error(`Codex rollout already exists: ${id}; pass --force`)
    return { target, text, keep }
  })
  for (const { target, text, keep } of targets) { if (!keep) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text) } }
}

/** Bundle only history visible to this fork, preserving byte offsets used by history_base. */
export function exportCodexHistory(id: string, destination: string, sessions = readCodexSessions()): void {
  const chain = codexHistoryFiles(id, sessions)
  mkdirSync(destination, { recursive: true })
  for (let i = 0; i < chain.length; i++) {
    let data = readFileSync(chain[i].file)
    const child = chain[i + 1]
    if (child) {
      const base = JSON.parse(readFileSync(child.file, 'utf8').split('\n')[0]).payload.history_base
      if (Number.isSafeInteger(base.end_byte_offset)) {
        if (base.end_byte_offset < 0 || base.end_byte_offset > data.length) throw new Error('Incomplete Codex ancestor: fork byte boundary is unavailable')
        data = data.subarray(0, base.end_byte_offset)
      } else {
        data = Buffer.from(data.toString('utf8').split('\n').filter((line, index) => {
          if (!line) return false
          const row = JSON.parse(line)
          return row.type === 'session_meta' || (row.ordinal ?? index) < base.end_ordinal_exclusive
        }).join('\n') + '\n')
      }
    }
    writeFileSync(join(destination, basename(chain[i].file)), data)
  }
}

export function codexUserMessages(id: string, sessions = readCodexSessions()): string[] {
  return codexHistory(id, sessions).flatMap((r) => {
    const p = r.payload
    if (r.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return []
    return [(p.content ?? []).filter((c: any) => c.type === 'input_text' || c.type === 'text').map((c: any) => c.text ?? '').join('\n')]
  })
}
