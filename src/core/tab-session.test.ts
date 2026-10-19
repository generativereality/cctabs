import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseProcessTable, registeredSessionOf } from './claude-procs.js'
import { liveTabSession, procTabsOf } from './tab-session.js'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const C = 'cccccccc-3333-4333-8333-333333333333'

// clerk-dev, 2026-10-19: tab renamed after Claude started, so no transcript is
// titled after it — but its Claude is running, under the tab's shell.
const rows = parseProcessTable(`
  100     1 /Applications/Tabby.app/Contents/MacOS/Tabby
  200   100 /bin/zsh -l
  201   200 claude --resume ${A} --name old-name
  300   100 /bin/zsh -l
  301   300 claude
`)
const tabs = [
  { tabId: 'clerk', name: 'clerk-dev', shellPid: 200 },
  { tabId: 'fresh', name: 'fresh-renamed', shellPid: 300 },
]

describe('liveTabSession', () => {
  it("names a renamed tab's session from its Claude's argv", () => {
    expect(liveTabSession('clerk', tabs, rows, () => undefined)).toEqual({ id: A, via: 'argv', pid: 201 })
  })

  it("prefers Claude Code's own registry, which also knows a session started fresh", () => {
    const reg = (pid: number) => (pid === 301 ? C : undefined)
    expect(liveTabSession('fresh', tabs, rows, reg)).toEqual({ id: C, via: 'registry', pid: 301 })
    expect(liveTabSession('fresh', tabs, rows, () => undefined)).toBeUndefined()
  })

  it('has no answer without a process table or a matching tab', () => {
    expect(liveTabSession('clerk', tabs, null, () => undefined)).toBeUndefined()
    expect(liveTabSession('nope', tabs, rows, () => undefined)).toBeUndefined()
  })
})

describe('registeredSessionOf', () => {
  it('reads <config>/sessions/<pid>.json, checking the pid inside', () => {
    const root = mkdtempSync(join(tmpdir(), 'cctabs-reg-'))
    mkdirSync(join(root, 'sessions'))
    writeFileSync(join(root, 'sessions', '301.json'), JSON.stringify({ pid: 301, sessionId: C, name: 'x' }))
    writeFileSync(join(root, 'sessions', '302.json'), JSON.stringify({ pid: 999, sessionId: C }))
    expect(registeredSessionOf(301, [join(root, 'missing'), root])).toBe(C)
    expect(registeredSessionOf(302, [root])).toBeUndefined()
    expect(registeredSessionOf(303, [root])).toBeUndefined()
  })
})

describe('procTabsOf', () => {
  it('keeps terminal tabs with their shell pid and name', () => {
    const tabsById = new Map([['t1', [{ view: 'term', shellPid: 5 }]], ['t2', [{ view: 'web' }]]]) as never
    expect(procTabsOf(tabsById, new Map([['t1', 'one']]))).toEqual([{ tabId: 't1', name: 'one', shellPid: 5 }])
  })
})
