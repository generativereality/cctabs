import { expect, test } from 'bun:test'
import { callerEngine, launchEngine } from './engine.js'

test('new inherits the nearest agent instead of a stale outer environment', () => {
  const rows = [
    { pid: 30, ppid: 20, command: 'node dist/index.js new review' },
    { pid: 20, ppid: 10, command: '/bin/codex resume abc' },
    { pid: 10, ppid: 1, command: 'claude' },
  ]
  expect(callerEngine(rows, 30, { CLAUDE_CODE_SESSION_ID: 'outer' })).toBe('codex')
  expect(callerEngine([{ ...rows[0] }, { ...rows[1], command: 'claude' }, { ...rows[2], command: 'codex' }], 30, { CODEX_THREAD_ID: 'outer' })).toBe('claude')
})

test('Codex tool environment works without a process table; plain shells remain Claude', () => {
  expect(callerEngine(null, 30, { CODEX_THREAD_ID: 'id' })).toBe('codex')
  expect(callerEngine(null, 30, { CODEX_SESSION_ID: 'id' })).toBe('codex')
  expect(callerEngine(null, 30, {})).toBe('claude')
  expect(callerEngine(null, 30, { CODEX_THREAD_ID: 'outer', CLAUDE_CODE_SESSION_ID: 'inner' })).toBe('claude')
})

test('explicit engine and backend override inheritance; invalid engines fail', () => {
  expect(launchEngine(undefined, undefined, 'codex')).toBe('codex')
  expect(launchEngine('claude', undefined, 'codex')).toBe('claude')
  expect(launchEngine('codex', undefined, 'claude')).toBe('codex')
  expect(launchEngine(undefined, 'anthropic', 'codex')).toBe('claude')
  expect(launchEngine('other', undefined, 'codex')).toBeNull()
})
