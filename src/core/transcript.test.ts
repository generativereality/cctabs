import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  countSessionsInDir,
  locateTranscriptFile,
  parseAssistantTurns,
  readAssistantTurns,
  readUserMessages,
  truncateTurn,
} from './transcript.js'
import { pathToProjectSlug } from './session.js'
import type { ClaudeConfigDir } from './config-dirs.js'

let tmp: string

/** A config dir as listClaudeConfigDirs would report it. */
function cfg(root: string, backend?: string): ClaudeConfigDir {
  return { root, projectsRoot: join(root, 'projects'), backend }
}

function writeTranscript(
  projectsRoot: string,
  dirForSlug: string,
  opts: { id: string; lines: string[]; mtimeSec?: number },
): string {
  const projectDir = join(projectsRoot, pathToProjectSlug(dirForSlug))
  mkdirSync(projectDir, { recursive: true })
  const file = join(projectDir, `${opts.id}.jsonl`)
  writeFileSync(file, opts.lines.join('\n') + '\n')
  if (opts.mtimeSec) utimesSync(file, opts.mtimeSec, opts.mtimeSec)
  return file
}

const assistantLine = (text: string, timestamp?: string) =>
  JSON.stringify({
    type: 'assistant',
    ...(timestamp ? { timestamp } : {}),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  })

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'cctabs-transcript-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe('parseAssistantTurns', () => {
  it('returns assistant text messages oldest first', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
      assistantLine('first'),
      assistantLine('second'),
    ].join('\n')
    expect(parseAssistantTurns(jsonl).map((t) => t.text)).toEqual(['first', 'second'])
  })

  it('joins multiple text blocks in one message', () => {
    const jsonl = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    })
    expect(parseAssistantTurns(jsonl)[0].text).toBe('a\nb')
  })

  it('accepts a plain string content', () => {
    const jsonl = JSON.stringify({ message: { role: 'assistant', content: 'plain' } })
    expect(parseAssistantTurns(jsonl).map((t) => t.text)).toEqual(['plain'])
  })

  // A turn that only called tools carries no prose. Emitting it as an empty
  // message would pad the "last 3 messages" window with nothing.
  it('skips tool-only and thinking-only assistant messages', () => {
    const jsonl = [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
      assistantLine('the answer'),
    ].join('\n')
    expect(parseAssistantTurns(jsonl).map((t) => t.text)).toEqual(['the answer'])
  })

  // A live session is being appended to as we read it, so the last line can be
  // half-written. That must not cost us the other messages.
  it('skips a truncated trailing line rather than failing', () => {
    const jsonl = [assistantLine('complete'), '{"message":{"role":"assist'].join('\n')
    expect(parseAssistantTurns(jsonl).map((t) => t.text)).toEqual(['complete'])
  })

  it('carries the entry timestamp when present', () => {
    expect(parseAssistantTurns(assistantLine('x', '2026-09-08T10:00:00Z'))[0].timestamp)
      .toBe('2026-09-08T10:00:00Z')
  })

  it('is empty for a transcript with no assistant messages', () => {
    expect(parseAssistantTurns(JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }))).toEqual([])
  })
})

describe('locateTranscriptFile', () => {
  // The requirement that makes this command usable on a real fleet: a tab
  // running under a backend preset writes beneath that preset's config dir, and
  // searching only ~/.claude reports "no transcript" for a healthy session.
  it('finds a transcript under a NON-default config dir and reports its backend', () => {
    const enterprise = cfg(join(tmp, '.claude-enterprise'), 'enterprise')
    const file = writeTranscript(enterprise.projectsRoot, '/work/repo', { id: 'sid-1', lines: [assistantLine('hi')] })

    const found = locateTranscriptFile('sid-1', [cfg(join(tmp, '.claude')), enterprise])
    expect(found?.file).toBe(file)
    expect(found?.backend).toBe('enterprise')
  })

  it('finds a transcript in the default dir, with no backend attached', () => {
    const dflt = cfg(join(tmp, '.claude'))
    writeTranscript(dflt.projectsRoot, '/work/repo', { id: 'sid-2', lines: [assistantLine('hi')] })

    const found = locateTranscriptFile('sid-2', [dflt])
    expect(found?.backend).toBeUndefined()
  })

  it('searches every project slug, not just one', () => {
    const dflt = cfg(join(tmp, '.claude'))
    writeTranscript(dflt.projectsRoot, '/a/one', { id: 'other', lines: [] })
    const wanted = writeTranscript(dflt.projectsRoot, '/b/two', { id: 'sid-3', lines: [assistantLine('hi')] })

    expect(locateTranscriptFile('sid-3', [dflt])?.file).toBe(wanted)
  })

  it('prefers the newest when the same id exists under two roots', () => {
    const a = cfg(join(tmp, '.claude'))
    const b = cfg(join(tmp, '.claude-other'), 'other')
    writeTranscript(a.projectsRoot, '/work/repo', { id: 'dup', lines: [assistantLine('old')], mtimeSec: 1000 })
    const newer = writeTranscript(b.projectsRoot, '/work/repo', { id: 'dup', lines: [assistantLine('new')], mtimeSec: 9000 })

    expect(locateTranscriptFile('dup', [a, b])?.file).toBe(newer)
  })

  it('returns null for an unknown id, and for an empty one', () => {
    const dflt = cfg(join(tmp, '.claude'))
    mkdirSync(dflt.projectsRoot, { recursive: true })
    expect(locateTranscriptFile('nope', [dflt])).toBeNull()
    expect(locateTranscriptFile('', [dflt])).toBeNull()
  })

  it('tolerates a config dir that does not exist on disk', () => {
    const missing = cfg(join(tmp, 'absent'))
    expect(locateTranscriptFile('any', [missing])).toBeNull()
  })
})

describe('readAssistantTurns', () => {
  it('reads a file from disk', () => {
    const dflt = cfg(join(tmp, '.claude'))
    const file = writeTranscript(dflt.projectsRoot, '/work/repo', {
      id: 'sid', lines: [assistantLine('one'), assistantLine('two')],
    })
    expect(readAssistantTurns(file).map((t) => t.text)).toEqual(['one', 'two'])
  })
})

describe('countSessionsInDir', () => {
  // This is what separates "the tab is dead" from "the tab was renamed after
  // Claude started" — the two failures a bare null conflates.
  it('counts .jsonl files for a directory across config dirs', () => {
    const a = cfg(join(tmp, '.claude'))
    const b = cfg(join(tmp, '.claude-other'), 'other')
    writeTranscript(a.projectsRoot, '/work/repo', { id: 's1', lines: [] })
    writeTranscript(a.projectsRoot, '/work/repo', { id: 's2', lines: [] })
    writeTranscript(b.projectsRoot, '/work/repo', { id: 's3', lines: [] })

    expect(countSessionsInDir('/work/repo', [a, b])).toBe(3)
  })

  it('is 0 when nothing has ever run there', () => {
    expect(countSessionsInDir('/never/used', [cfg(join(tmp, '.claude'))])).toBe(0)
  })
})

describe('truncateTurn', () => {
  it('leaves text alone with no limit, or under the limit', () => {
    expect(truncateTurn('short')).toBe('short')
    expect(truncateTurn('short', 100)).toBe('short')
  })

  it('says how much it cut rather than trimming silently', () => {
    const out = truncateTurn('abcdefghij', 4)
    expect(out.startsWith('abcd')).toBe(true)
    expect(out).toContain('6 more characters')
  })
})

describe('readUserMessages', () => {
  const write = (lines: string[]): string => {
    const dflt = cfg(join(tmp, '.claude'))
    return writeTranscript(dflt.projectsRoot, '/work/repo', { id: 'sid-users', lines })
  }

  it('returns typed user messages oldest first', () => {
    const file = write([
      JSON.stringify({ type: 'user', origin: 'cli', message: { role: 'user', content: 'first' } }),
      assistantLine('an answer'),
      JSON.stringify({ type: 'user', origin: 'cli', message: { role: 'user', content: 'second' } }),
    ])
    expect(readUserMessages(file)).toEqual(['first', 'second'])
  })

  // THE FIX. Claude records a tool's OUTPUT as a role:"user" message, so the
  // newest user-role entry in a live session is usually a tool result. A
  // `--path` handoff makes the tab read a file, and treating that file as "the
  // last thing sent to this tab" made the delivery check compare the handoff
  // against the file and report that the payload matched neither end of itself.
  // The entry shapes here are copied from a real transcript.
  it('excludes tool results, which are recorded as user messages', () => {
    const file = write([
      JSON.stringify({
        type: 'user', origin: 'cli', promptSource: 'text',
        message: { role: 'user', content: 'Read the file at /tmp/brief.txt in full' },
      }),
      JSON.stringify({
        type: 'user',
        toolUseResult: { type: 'text', file: { filePath: '/tmp/brief.txt' } },
        sourceToolAssistantUUID: 'abc',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'THE ENTIRE FILE CONTENTS' }] },
      }),
    ])
    expect(readUserMessages(file)).toEqual(['Read the file at /tmp/brief.txt in full'])
  })

  // Belt and braces: even if a tool result arrives as a plain string rather
  // than a content block, `toolUseResult` still identifies it.
  it('excludes a tool result whose content is a bare string', () => {
    const file = write([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'the real message' } }),
      JSON.stringify({ type: 'user', toolUseResult: 'anything', message: { role: 'user', content: 'file contents' } }),
    ])
    expect(readUserMessages(file)).toEqual(['the real message'])
  })

  it('joins multiple text blocks and skips empty ones', () => {
    const file = write([
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: {} }] } }),
    ])
    expect(readUserMessages(file)).toEqual(['a\nb'])
  })

  it('skips a truncated trailing line rather than failing', () => {
    const file = write([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'complete' } }),
      '{"message":{"role":"us',
    ])
    expect(readUserMessages(file)).toEqual(['complete'])
  })

  it('is empty for a transcript with no user messages', () => {
    expect(readUserMessages(write([assistantLine('only me')]))).toEqual([])
  })
})
