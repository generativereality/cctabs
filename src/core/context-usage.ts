import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type { CodexSession } from './codex-sessions.js'
import { codexResumeId, matchCodexTabs } from './codex-sessions.js'
import { liveSessionOf, matchTabsToClaude, type ProcRow } from './claude-procs.js'
import { locateTranscriptFile } from './transcript.js'
import type { Block } from '../types/index.js'

/**
 * How full a session's context window is, read from its transcript rather
 * than its screen.
 *
 * Both agents write what the next turn will cost into their session file:
 * Claude Code puts the API `usage` on every assistant entry, and Codex writes a
 * `token_count` event carrying `model_context_window`. The last one is the
 * answer, so only the file's tail is read — a long session's transcript runs to
 * tens of megabytes and reading all of it per tab would make a listing slow.
 */
export interface ContextUsage {
  /** Tokens the next turn starts from: the last request's input plus its output. */
  used: number
  /** The model's context window, in tokens. */
  window: number
  /** `used / window`, 0–100, rounded. */
  percent: number
  /**
   * Where `window` came from. `reported`: the session file states it (Codex,
   * or Claude Code's model attachment). `usage`: past 200k, so it can only be
   * the 1M window. `inferred`: the model alone, which cannot tell a 1M-context
   * session from a 200k one (older Claude Code wrote no model attachment).
   */
  window_source: 'reported' | 'usage' | 'inferred'
}

const CLAUDE_DEFAULT_WINDOW = 200_000
const CLAUDE_1M_WINDOW = 1_000_000
const TAIL_START = 256 * 1024
const TAIL_MAX = 8 * 1024 * 1024
const HEAD_BYTES = 256 * 1024
const IDENTITY_MAX = 16 * 1024 * 1024
const CHUNK = 1024 * 1024
const LINE_MAX = 64 * 1024

/** The window a Claude model id or marketing name announces. */
export function claudeWindowOf(modelId: string, marketingName = ''): number {
  return /\[1m\]/i.test(modelId) || /\b1M context\b/i.test(marketingName) ? CLAUDE_1M_WINDOW : CLAUDE_DEFAULT_WINDOW
}

const baseModel = (id: string) => id.replace(/\[[^\]]*\]$/, '')

interface ClaudeScan {
  /** Tokens in context at the last point we could see, if found. */
  used?: number
  /** The model the last assistant entry ran on. */
  model?: string
  /** The newest model attachment: `{modelId, marketingName}`. */
  identity?: { modelId: string; marketingName: string }
}

/**
 * Scan transcript lines newest-first for the context size and the model.
 *
 * Pure: takes the lines, so it is tested without a file. A compact boundary
 * met before any assistant entry means the conversation was just compacted and
 * nothing has run since — its `postTokens` is then the size.
 */
export function scanClaudeLines(lines: string[], into: ClaudeScan = {}): ClaudeScan {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    // Cheap prefilter: most lines are tool results and user text.
    const isAssistant = into.used === undefined && line.includes('"type":"assistant"') && line.includes('"usage"')
    const isBoundary = into.used === undefined && line.includes('"compact_boundary"')
    const isModel = !into.identity && line.includes('"attachment":{"type":"model"')
    if (!isAssistant && !isBoundary && !isModel) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue } // the tail's first line is usually cut
    if (isModel && e.attachment?.type === 'model' && typeof e.attachment.identity?.modelId === 'string') {
      into.identity = { modelId: e.attachment.identity.modelId, marketingName: String(e.attachment.identity.marketingName ?? '') }
    }
    if (into.used === undefined && e.type === 'assistant' && !e.isSidechain) {
      const u = e.message?.usage
      const model = String(e.message?.model ?? '')
      // `<synthetic>` entries (an interrupt, an API error) carry zeroed usage.
      if (u && model && model !== '<synthetic>') {
        into.used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
        into.model = model
      }
    } else if (into.used === undefined && e.type === 'system' && e.subtype === 'compact_boundary') {
      const post = e.compactMetadata?.postTokens
      if (typeof post === 'number') into.used = post
    }
    if (into.used !== undefined && into.identity) break
  }
  return into
}

/** The last `bytes` of a file, split into lines. */
function readTail(file: string, size: number, bytes: number): string[] {
  const start = Math.max(0, size - bytes)
  return readRange(file, start, size - start)
}

function readRange(file: string, start: number, length: number): string[] {
  return readBytes(file, start, length).toString('utf8').split('\n')
}

function readBytes(file: string, start: number, length: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const n = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

const MODEL_MARKER = Buffer.from('"attachment":{"type":"model"')

/**
 * The newest model attachment in a file's last `bytes`, found by a byte search
 * so that only its own line is decoded and parsed. Splitting and scanning a
 * 16 MB tail line by line cost ~300 ms over a 43-tab listing.
 */
function lastModelLine(file: string, size: number, bytes: number): string[] {
  const floor = Math.max(0, size - bytes)
  // Backwards in chunks, stopping at the first hit. A chunk ends where the
  // previous one began plus the marker's length, so a marker split across the
  // boundary is still seen whole.
  for (let end = size; end > floor; ) {
    const start = Math.max(floor, end - CHUNK)
    const buf = readBytes(file, start, Math.min(size, end + MODEL_MARKER.length) - start)
    const at = buf.lastIndexOf(MODEL_MARKER)
    if (at >= 0) {
      // Its line starts a little before the marker, possibly in the chunk
      // before this one: re-read a bounded window around it.
      const pos = start + at
      const winStart = Math.max(0, pos - LINE_MAX)
      const win = readBytes(file, winStart, Math.min(size, pos + LINE_MAX) - winStart)
      const rel = pos - winStart
      const from = win.lastIndexOf(0x0a, rel) + 1
      const to = win.indexOf(0x0a, rel)
      return [win.subarray(from, to < 0 ? win.length : to).toString('utf8')]
    }
    end = start
  }
  return []
}

/** Context usage of a Claude Code transcript, or null when it has no turn yet. */
export function claudeContextUsage(file: string): ContextUsage | null {
  let size: number
  try { size = statSync(file).size } catch { return null }
  let scan: ClaudeScan = {}
  // Grow the tail until the last turn is in it. The model attachment is
  // written at session start and after each compaction, so it is often further
  // back than the last turn: when the tail lacks one, the head has the first.
  let bytes = TAIL_START
  for (;;) {
    scan = scanClaudeLines(readTail(file, size, bytes), {})
    if (scan.used !== undefined || bytes >= size || bytes >= TAIL_MAX) break
    bytes *= 4
  }
  if (scan.used === undefined) return null
  // Then look further back for the model attachment alone (a scan that
  // already has `used` parses nothing else). Measured: in a 13 MB transcript
  // the newest attachment sat 4,000 lines from the end, past a 256 KB tail.
  if (!scan.identity && size > bytes) scanClaudeLines(lastModelLine(file, size, IDENTITY_MAX), scan)
  if (!scan.identity && size > IDENTITY_MAX) scanClaudeLines(readRange(file, 0, HEAD_BYTES), scan)

  // The attachment only speaks for the model the last turn ran on: after a
  // `/model` switch it may describe the previous one.
  const id = scan.identity
  const reported = id && (!scan.model || baseModel(id.modelId) === baseModel(scan.model))
  const window = reported ? claudeWindowOf(id.modelId, id.marketingName) : claudeWindowOf(scan.model ?? '')
  // A session already past 200k can only be on a 1M window.
  if (scan.used > window) return toUsage(scan.used, CLAUDE_1M_WINDOW, 'usage')
  return toUsage(scan.used, window, reported ? 'reported' : 'inferred')
}

/**
 * Pure: the last `token_count` event in Codex rollout lines. Codex reports the
 * window itself, so nothing is inferred.
 */
export function scanCodexLines(lines: string[]): { used: number; window: number } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line?.includes('"token_count"')) continue
    let e: any
    try { e = JSON.parse(line) } catch { continue }
    const info = e.payload?.type === 'token_count' ? e.payload.info : undefined
    const last = info?.last_token_usage
    if (!last || typeof info.model_context_window !== 'number') continue
    const used = typeof last.total_tokens === 'number' ? last.total_tokens : (last.input_tokens ?? 0) + (last.output_tokens ?? 0)
    return { used, window: info.model_context_window }
  }
  return null
}

/** Context usage of a Codex rollout file, or null when no turn has run. */
export function codexContextUsage(file: string): ContextUsage | null {
  let size: number
  try { size = statSync(file).size } catch { return null }
  for (let bytes = TAIL_START; ; bytes *= 4) {
    const hit = scanCodexLines(readTail(file, size, bytes))
    if (hit) return toUsage(hit.used, hit.window, 'reported')
    if (bytes >= size || bytes >= TAIL_MAX) return null
  }
}

function toUsage(used: number, window: number, source: ContextUsage['window_source']): ContextUsage {
  return { used, window, percent: Math.round((used / window) * 100), window_source: source }
}

/** `ctx 42%`, or `ctx ~42%` when the window was inferred rather than reported. */
export function formatContext(u: ContextUsage): string {
  return `ctx ${u.window_source === 'inferred' ? '~' : ''}${u.percent}%`
}

/**
 * Context usage per tab, found through the process table alone: the agent
 * running in each tab names its session (Claude Code's registry or `--resume`;
 * Codex's rollout match). No title search, so this stays fast enough for the
 * human listings. A tab with no live agent is absent.
 */
export function contextByTab(
  tabsById: Map<string, Block[]>,
  tabNames: Map<string, string>,
  procRows: ProcRow[] | null,
  codexSessions: CodexSession[],
): Map<string, ContextUsage> {
  const out = new Map<string, ContextUsage>()
  if (!procRows) return out
  const tabs = [...tabsById].flatMap(([tabId, blocks]) => {
    const b = blocks.find((x) => x.view === 'term')
    return b ? [{ tabId, name: tabNames.get(tabId) ?? tabId.slice(0, 8), shellPid: b.shellPid, cwd: b.meta?.['cmd:cwd'] }] : []
  })
  for (const [tabId, tp] of matchTabsToClaude(tabs, procRows)) {
    const live = liveSessionOf(tp.proc)
    const file = live && locateTranscriptFile(live.id)?.file
    const u = file ? safe(() => claudeContextUsage(file)) : null
    if (u) out.set(tabId, u)
  }
  for (const [tabId, cx] of matchCodexTabs(tabs, procRows, codexSessions)) {
    if (out.has(tabId)) continue
    const id = cx.id ?? codexResumeId(cx.proc.command)
    const file = cx.session?.file ?? codexSessions.find((s) => s.id === id)?.file
    const u = file ? safe(() => codexContextUsage(file)) : null
    if (u) out.set(tabId, u)
  }
  return out
}

/**
 * Context usage of a session known by id, for when there is no live process
 * to ask: a suspended tab's registry names its session and engine exactly.
 */
export function contextOfSession(id: string, engine: 'claude' | 'codex' | string | undefined, codexSessions: CodexSession[]): ContextUsage | null {
  if (engine === 'codex') {
    const file = codexSessions.find((s) => s.id === id)?.file
    return file ? safe(() => codexContextUsage(file)) : null
  }
  const file = locateTranscriptFile(id)?.file
  return file ? safe(() => claudeContextUsage(file)) : null
}

/** A listing must not fail because one transcript could not be read. */
function safe<T>(f: () => T): T | null {
  try { return f() } catch { return null }
}
