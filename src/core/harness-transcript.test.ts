import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  harnessInShell,
  opencodeMajor,
  opencodeSessionArg,
  parseOpencodeExport,
  parsePiTurns,
  piSessionDirName,
  piSessionMeta,
  pickOpencodeSession,
  readPiTranscript,
} from './harness-transcript.js'

const rows = [
  { pid: 100, ppid: 1, command: '/bin/zsh -l -i -c opencode --prompt=hi; exec /bin/zsh -l -i' },
  { pid: 101, ppid: 100, command: 'opencode --prompt=hi' },
  { pid: 200, ppid: 1, command: '/bin/zsh -l -i' },
  { pid: 201, ppid: 200, command: 'vim notes.md' },
  { pid: 300, ppid: 1, command: 'zsh' },
  { pid: 301, ppid: 300, command: 'pi' },
]

describe('harnessInShell', () => {
  test('finds the harness under the tab shell, not the shell line that names it', () => {
    expect(harnessInShell(100, rows)).toEqual({ harness: 'opencode', proc: rows[1] })
    expect(harnessInShell(300, rows)?.harness).toBe('pi')
  })
  test('nothing for a shell running something else, or no shell pid', () => {
    expect(harnessInShell(200, rows)).toBeUndefined()
    expect(harnessInShell(undefined, rows)).toBeUndefined()
  })
})

const piSession = [
  JSON.stringify({ type: 'session', version: 3, id: 'abc-123', timestamp: '2026-11-05T08:24:56.577Z', cwd: '/w' }),
  JSON.stringify({ type: 'session_info', id: 'x', timestamp: '2026-11-05T08:24:56.577Z', name: 't-pi' }),
  JSON.stringify({ type: 'message', timestamp: '2026-11-05T19:04:00.162Z', message: { role: 'user', content: [{ type: 'text', text: 'Reply with PONG' }] } }),
  JSON.stringify({ type: 'message', timestamp: '2026-11-05T19:04:05.801Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'PONG' }] } }),
  JSON.stringify({ type: 'message', timestamp: '2026-11-05T19:05:00.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] } }),
  '{"type":"message","mess',
].join('\n')

describe('pi', () => {
  test('dir name matches pi session-manager encoding', () => {
    expect(piSessionDirName('/private/tmp/a/-b/c')).toBe('--private-tmp-a--b-c--')
    expect(piSessionDirName('C:\\Users\\fred\\proj')).toBe('--C--Users-fred-proj--')
  })
  test('assistant text turns only, torn last line ignored', () => {
    expect(parsePiTurns(piSession)).toEqual([{ text: 'PONG', timestamp: '2026-11-05T19:04:05.801Z' }])
  })
  test('id and name from header and session_info', () => {
    expect(piSessionMeta(piSession)).toEqual({ id: 'abc-123', name: 't-pi' })
  })
  test('picks the session named after the tab over a newer one', () => {
    const agent = mkdtempSync(join(tmpdir(), 'pi-agent-'))
    const dir = join(agent, 'sessions', piSessionDirName('/w'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.jsonl'), piSession)
    utimesSync(join(dir, 'a.jsonl'), 1, 1)
    writeFileSync(join(dir, 'b.jsonl'), JSON.stringify({ type: 'session', id: 'other' }))
    const named = readPiTranscript('/w', 't-pi', agent)
    expect(typeof named === 'object' && named.sessionId).toBe('abc-123')
    expect(typeof named === 'object' && named.matchedBy).toBe('name')
    const newest = readPiTranscript('/w', 'other-tab', agent)
    expect(typeof newest === 'object' && newest.sessionId).toBe('other')
    expect(typeof newest === 'object' && newest.matchedBy).toBe('newest-in-dir')
    expect(typeof readPiTranscript('/nowhere', 't', agent)).toBe('string')
  })
})

describe('opencode', () => {
  test('assistant text parts from export', () => {
    const json = JSON.stringify({
      info: {},
      messages: [
        { info: { role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'hi' }] },
        { info: { role: 'assistant', time: { created: 2 } }, parts: [] },
        { info: { role: 'assistant', time: { created: 1794074798193, completed: 1794074802476 } }, parts: [{ type: 'step-start' }, { type: 'reasoning', text: '' }, { type: 'text', text: 'PONG' }] },
      ],
    })
    expect(parseOpencodeExport(json)).toEqual([{ text: 'PONG', timestamp: new Date(1794074802476).toISOString() }])
  })
  test('assistant text from a 2.x session export', () => {
    const json = JSON.stringify({
      info: {},
      messages: [
        { id: 'm1', time: { created: 1 }, text: 'Read README.txt', type: 'user' },
        { id: 'm2', time: { created: 2, completed: 3 }, type: 'assistant', content: [{ type: 'tool', name: 'read' }] },
        { id: 'm3', time: { created: 4, completed: 1794075424482 }, type: 'assistant', content: [{ type: 'text', text: 'hello from the engine test' }] },
        { id: 'm4', time: { created: 5 }, type: 'idle', outcome: 'succeeded' },
      ],
    })
    expect(parseOpencodeExport(json)).toEqual([{ text: 'hello from the engine test', timestamp: new Date(1794075424482).toISOString() }])
  })
  test('major version from either --version format', () => {
    expect(opencodeMajor('1.19.5\n')).toBe(1)
    expect(opencodeMajor('opencode v2.2.6')).toBe(2)
    expect(opencodeMajor('garbage')).toBeUndefined()
  })
  test('session from argv first, else newest in the folder', () => {
    const s = [
      { id: 'old', directory: '/w', updated: 1 },
      { id: 'new', directory: '/w', updated: 2 },
      { id: 'elsewhere', directory: '/x', updated: 9 },
    ]
    expect(pickOpencodeSession(s, ['/w'], 'old')).toEqual({ id: 'old', matchedBy: 'session-arg' })
    expect(pickOpencodeSession(s, ['/w'])).toEqual({ id: 'new', matchedBy: 'newest-in-dir' })
    expect(pickOpencodeSession(s, ['/w'], 'gone')).toEqual({ id: 'new', matchedBy: 'newest-in-dir' })
    expect(pickOpencodeSession(s, ['/none'])).toBeUndefined()
  })
  test('session flag forms', () => {
    expect(opencodeSessionArg('opencode --session ses_1 --prompt=x')).toBe('ses_1')
    expect(opencodeSessionArg('opencode -s ses_2')).toBe('ses_2')
    expect(opencodeSessionArg('opencode --session=ses_3')).toBe('ses_3')
    expect(opencodeSessionArg('opencode --prompt=hi')).toBeUndefined()
  })
})
