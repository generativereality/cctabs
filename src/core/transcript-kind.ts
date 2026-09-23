import { readFileSync, statSync } from 'fs'

/**
 * Is a transcript a conversation, or only a metadata trailer?
 *
 * Its own module, with no imports from the rest of core, because every lookup
 * needs it — title index, id lookup, transcript location, session copy — and
 * those modules import one another.
 *
 * A closing Claude Code process writes a short trailer — `custom-title`,
 * `agent-name`, `mode`, `permission-mode`, `pr-link` — to its transcript path.
 * If the real transcript has already been moved away, that trailer *recreates*
 * the file: a handful of lines, no messages, and a `customTitle`. It can never
 * be resumed (`claude --resume` answers "No conversation found"), yet it
 * matches by title and by id. Measured: three such stubs, left in one Claude
 * config dir after their sessions were moved to another, made `cctabs manifest`
 * record the wrong account, and restore launched all three into an empty
 * conversation.
 */

/** Entry types that constitute an actual conversation, as opposed to metadata. */
const CONVERSATION_TYPES = new Set(['user', 'assistant'])

/**
 * Cheap, text-level check for whether transcript content holds any message.
 * Claude writes compact JSON, so the substring is exact; used on the hot path
 * (the title index reads every transcript in a project dir).
 */
export function hasConversationText(content: string): boolean {
  return content.includes('"type":"user"') || content.includes('"type":"assistant"')
}

/**
 * True when a transcript holds only metadata and no conversation. Strict: any
 * unparseable line, or a line naming a different session, answers false — it
 * is also the gate for DELETING a stub, so it must never fire on a damaged
 * real transcript.
 */
export function isMetadataOnlyTranscript(file: string, sessionId?: string): boolean {
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return false
  }
  let sawAny = false
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: unknown; sessionId?: unknown }
    try {
      entry = JSON.parse(line)
    } catch {
      // An unparseable line means this isn't a tidy little trailer. Refuse to
      // call it a stub rather than risk deleting a damaged real transcript.
      return false
    }
    sawAny = true
    if (typeof entry.type === 'string' && CONVERSATION_TYPES.has(entry.type)) return false
    // Every trailer line names the session it belongs to. Requiring the match
    // keeps this from ever firing on some unrelated file that happens to be
    // short.
    if (sessionId && entry.sessionId !== undefined && entry.sessionId !== sessionId) return false
  }
  return sawAny
}

/**
 * Size above which a transcript is taken to be a conversation without reading
 * it. Measured trailers are 1.0–1.3 KB; the check exists to keep id lookups —
 * run once per entry across a 60-tab restore, against transcripts of 20 MB and
 * more — from reading every file in full.
 */
const TRAILER_MAX_BYTES = 64 * 1024

/** {@link isMetadataOnlyTranscript}, reading the file only when it is small enough to be one. */
export function isTrailerFile(file: string, sessionId?: string): boolean {
  try {
    if (statSync(file).size > TRAILER_MAX_BYTES) return false
  } catch {
    return false
  }
  return isMetadataOnlyTranscript(file, sessionId)
}
