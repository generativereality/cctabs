import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { extname, join } from 'path'
import { originOf, scopeToDirs, type ConfigDirScope, type SessionOrigin } from './config-dirs.js'
import { pathToProjectSlug } from './session.js'

/** A session's transcript file, and which Claude account it was found under. */
export interface LocatedTranscript extends SessionOrigin {
  file: string
  mtime: number
}

/**
 * Find a session's transcript by id, across EVERY Claude config dir on the
 * machine and every project slug inside them.
 *
 * The breadth is the whole point, and it is not defensive programming: a tab
 * running under a backend preset writes its transcript beneath that preset's
 * `CLAUDE_CONFIG_DIR` (say `~/.claude-enterprise/projects`), invisible to
 * anything that only looks in `~/.claude/projects`. A search that checks one
 * root reports "no transcript" for a perfectly healthy session — which a driver
 * reads as "that tab is dead" and acts on. So: all roots, and the answer
 * carries the origin so callers can say which account it came from.
 *
 * Unlike `findSessionFileById`, this needs no candidate directories — the id
 * alone is enough, which is what a tab-to-session lookup has to work from.
 * Newest wins if the same id somehow exists under two roots.
 */
export function locateTranscriptFile(
  sessionId: string,
  scope?: ConfigDirScope,
): LocatedTranscript | null {
  if (!sessionId) return null
  let best: LocatedTranscript | null = null

  for (const cfg of scopeToDirs(scope)) {
    if (!existsSync(cfg.projectsRoot)) continue
    const origin = originOf(cfg)

    for (const slug of readdirSync(cfg.projectsRoot)) {
      const file = join(cfg.projectsRoot, slug, `${sessionId}.jsonl`)
      let mtime: number
      try {
        const st = statSync(file)
        if (!st.isFile()) continue
        mtime = st.mtimeMs
      } catch {
        continue
      }
      if (!best || mtime > best.mtime) best = { file, mtime, ...origin }
    }
  }

  return best
}

/** One assistant message that carried text, in transcript order. */
export interface AssistantTurn {
  text: string
  /** The entry's own timestamp, when it recorded one. */
  timestamp?: string
}

/**
 * The assistant's text messages in a transcript, oldest first.
 *
 * Text messages, not "turns" in the conversational sense: a single turn is
 * written as many entries when it calls tools, and most of those carry only
 * `tool_use` blocks. Those are dropped — they are the mechanics of the work,
 * not what the session concluded, and a caller asking "what has this tab
 * learned?" wants the prose. Thinking blocks are dropped for the same reason
 * plus one more: they are not the session's stated answer.
 *
 * Malformed lines are skipped rather than fatal. A transcript being appended to
 * right now can have a half-written last line, and refusing to read the other
 * 4,000 entries because of it would make this useless on exactly the live
 * sessions it exists for.
 */
export function parseAssistantTurns(jsonl: string): AssistantTurn[] {
  const turns: AssistantTurn[] = []

  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let entry: {
      message?: { role?: string; content?: unknown }
      timestamp?: string
    }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.message?.role !== 'assistant') continue

    const content = entry.message.content
    const text = Array.isArray(content)
      ? content
          .filter(
            (c): c is { type: string; text: string } =>
              !!c && typeof c === 'object' && (c as { type?: string }).type === 'text' &&
              typeof (c as { text?: unknown }).text === 'string',
          )
          .map((c) => c.text)
          .join('\n')
      : typeof content === 'string'
        ? content
        : ''

    if (!text.trim()) continue
    turns.push({ text: text.trim(), timestamp: entry.timestamp })
  }

  return turns
}

/** {@link parseAssistantTurns} for a file on disk. */
export function readAssistantTurns(file: string): AssistantTurn[] {
  return parseAssistantTurns(readFileSync(file, 'utf-8'))
}

/**
 * How many sessions exist in a directory's project folder, across all config
 * dirs, regardless of what they are titled.
 *
 * Used to tell two very different failures apart when a tab's session can't be
 * resolved by name: nothing has ever run here (count 0 — the tab really has no
 * session), versus sessions exist but none is titled after this tab (count > 0
 * — a title drifted, and the transcript is right there). Reported by `sessions`
 * and `transcript` instead of a bare null, because acting on the wrong one of
 * those two means either restoring a session that isn't there or abandoning one
 * that is.
 */
export function countSessionsInDir(dir: string, scope?: ConfigDirScope): number {
  let count = 0
  for (const cfg of scopeToDirs(scope)) {
    const projectDir = join(cfg.projectsRoot, pathToProjectSlug(dir))
    if (!existsSync(projectDir)) continue
    try {
      count += readdirSync(projectDir).filter((f) => extname(f) === '.jsonl').length
    } catch {
      // unreadable project dir contributes nothing
    }
  }
  return count
}

/** Trim a turn's text for display, marking that it was cut. */
export function truncateTurn(text: string, maxChars?: number): string {
  if (!maxChars || text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n… [${text.length - maxChars} more characters — raise --chars or read the transcript directly]`
}

/**
 * The text of the most recent user message in a transcript.
 *
 * Used to verify a delivery against ground truth: this is what the receiving
 * session actually got, as opposed to what the terminal appeared to show. Note
 * that Claude appends its own context (system reminders and the like) to the
 * recorded message, so this is a superset of the payload — which is why callers
 * check that the payload's ends are *contained* in it rather than comparing
 * lengths.
 *
 * Returns null when the transcript holds no user message with text, which is
 * the honest answer for a turn that hasn't started yet.
 */
export function readLastUserMessage(file: string): string | null {
  let latest: string | null = null

  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let entry: { message?: { role?: string; content?: unknown } }
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.message?.role !== 'user') continue

    const content = entry.message.content
    const text = Array.isArray(content)
      ? content
          .filter(
            (c): c is { type: string; text: string } =>
              !!c && typeof c === 'object' && (c as { type?: string }).type === 'text' &&
              typeof (c as { text?: unknown }).text === 'string',
          )
          .map((c) => c.text)
          .join('\n')
      : typeof content === 'string'
        ? content
        : ''

    if (text.trim()) latest = text
  }

  return latest
}
