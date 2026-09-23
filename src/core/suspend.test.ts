import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ProcRow } from './claude-procs.js'
import {
  matchSuspendedTabs,
  placeholderBody,
  placeholderSessions,
  readRecords,
  recordPath,
  removeRecord,
  shellCanHostPlaceholder,
  writeRecord,
  type SuspendRecord,
  type SuspendTab,
} from './suspend.js'

const ID = '0a1b2c3d-1111-2222-3333-444455556666'
const ID2 = '9f8e7d6c-1111-2222-3333-444455556666'

const spec = {
  sessionId: ID,
  name: "it's $odd",
  dir: '/work/my repo',
  env: { CLAUDE_CONFIG_DIR: '/cfg dir' },
  model: 'opus[1m]',
  permissionMode: 'plan' as const,
  extraFlags: ['--allow-dangerously-skip-permissions'],
  detail: '1.2MB · ~/work',
  recordFile: '/reg/x.json',
}

describe('placeholderBody', () => {
  const body = placeholderBody(spec)

  it('puts the tag and session id at the head of argv, where ps shows them', () => {
    expect(body.startsWith(`true cctabs-suspended ${ID};`)).toBe(true)
  })

  it('waits on read, with a Ctrl-C handler so an interrupt does not kill the tab', () => {
    expect(body).toContain("trap 'true' INT; read cctabs_wake; trap - INT")
  })

  it('deletes its own registry record before Claude starts', () => {
    expect(body.indexOf("rm -f '/reg/x.json'")).toBeLessThan(body.indexOf('claude '))
  })

  it('echoes the wake nonce back, so a waker can find its own wake in the buffer', () => {
    expect(body).toContain('"$cctabs_wake"')
  })

  it('resumes the session with every value shell-quoted', () => {
    expect(body).toContain(`cd '/work/my repo' && CLAUDE_CONFIG_DIR='/cfg dir' claude '--allow-dangerously-skip-permissions' --resume ${ID} --name 'it'\\''s $odd' --model 'opus[1m]' --permission-mode plan`)
  })
})

describe('shellCanHostPlaceholder', () => {
  it('accepts bash and zsh, refuses fish and cmd', () => {
    expect(shellCanHostPlaceholder({ command: '/bin/zsh', posix: true })).toBe(true)
    expect(shellCanHostPlaceholder({ command: 'C:\\Program Files\\Git\\bin\\bash.exe', posix: true })).toBe(true)
    expect(shellCanHostPlaceholder({ command: '/opt/homebrew/bin/fish', posix: true })).toBe(false)
    expect(shellCanHostPlaceholder({ command: 'cmd.exe', posix: false })).toBe(false)
  })
})

/** A placeholder shell as `ps -Aww` prints it. */
const phRow = (pid: number, id: string, ppid = 1): ProcRow => ({
  pid, ppid, command: `/bin/zsh -l -i -c true cctabs-suspended ${id}; printf '\\n  ⏸ cctabs suspended — %s' 'x'; read cctabs_wake`,
})

describe('placeholderSessions', () => {
  it('finds a waiting placeholder by the session in its argv', () => {
    expect(placeholderSessions([phRow(100, ID)]).get(ID)).toEqual({ pid: 100, woken: false })
  })

  it('reads a placeholder with a Claude beneath it as woken', () => {
    const rows = [phRow(100, ID), { pid: 101, ppid: 100, command: `claude --resume ${ID} --name x` }]
    expect(placeholderSessions(rows).get(ID)?.woken).toBe(true)
  })

  it('ignores a Claude whose argv merely mentions the tag, and unrelated shells', () => {
    const rows = [
      { pid: 5, ppid: 1, command: `claude -p "what is true cctabs-suspended ${ID}"` },
      { pid: 6, ppid: 1, command: '/bin/zsh -l -i' },
    ]
    expect(placeholderSessions(rows).size).toBe(0)
  })
})

const rec = (over: Partial<SuspendRecord> = {}): SuspendRecord => ({
  sessionId: ID, name: 'alpha', tabId: 't1', dir: '/d', suspendedAt: '2026-09-23T00:00:00Z', ...over,
})
const tab = (over: Partial<SuspendTab> = {}): SuspendTab => ({ tabId: 't1', name: 'alpha', claudeRunning: false, ...over })

describe('matchSuspendedTabs', () => {
  it('ties a tab to its record by tab id, confirmed by a waiting placeholder', () => {
    const m = matchSuspendedTabs([tab({ shellPid: 100, shellAlive: true })], [rec()], placeholderSessions([phRow(100, ID)]))
    expect(m.get('t1')).toMatchObject({ via: 'registry' })
    expect(m.get('t1')?.dormant).toBeUndefined()
  })

  it('re-finds a record by name after a Tabby restart changed every tab id', () => {
    const m = matchSuspendedTabs([tab({ tabId: 'new-id' })], [rec({ tabId: 'old-id' })], new Map([[ID, { pid: 7, woken: false }]]))
    expect(m.get('new-id')).toMatchObject({ via: 'registry-name' })
  })

  it('does not match by name when two tabs share it', () => {
    const tabs = [tab({ tabId: 'a' }), tab({ tabId: 'b' })]
    expect(matchSuspendedTabs(tabs, [rec({ tabId: 'gone' })], null).size).toBe(0)
  })

  it('does not re-home a record whose own tab is still present', () => {
    const tabs = [tab({ tabId: 't1', name: 'other' }), tab({ tabId: 't2', name: 'alpha' })]
    const m = matchSuspendedTabs(tabs, [rec({ tabId: 't1' })], new Map([[ID, { pid: 1, woken: false }]]))
    expect(m.has('t2')).toBe(false)
  })

  it('finds a placeholder from the process alone, when the tab shell IS one', () => {
    const m = matchSuspendedTabs([tab({ shellPid: 100, cwd: '/c' })], [], placeholderSessions([phRow(100, ID2)]))
    expect(m.get('t1')).toMatchObject({ via: 'process', record: { sessionId: ID2 } })
  })

  it('reports awake once Claude runs, even with the record still on disk', () => {
    expect(matchSuspendedTabs([tab({ claudeRunning: true })], [rec()], new Map()).size).toBe(0)
    const woken = new Map([[ID, { pid: 1, woken: true }]])
    expect(matchSuspendedTabs([tab()], [rec()], woken).size).toBe(0)
  })

  it('calls a registered tab with no placeholder process and no live shell dormant', () => {
    const m = matchSuspendedTabs([tab({ shellAlive: false })], [rec()], new Map())
    expect(m.get('t1')?.dormant).toBe(true)
  })

  it('drops a registry entry contradicted by a live non-placeholder shell', () => {
    expect(matchSuspendedTabs([tab({ shellPid: 9, shellAlive: true })], [rec()], new Map()).size).toBe(0)
  })

  it('only reads the screen when there is neither a record nor a process table', () => {
    const asked: string[] = []
    const marker = (id: string) => { asked.push(id); return true }
    matchSuspendedTabs([tab()], [rec()], new Map(), marker)
    expect(asked).toEqual([])
    const m = matchSuspendedTabs([tab({ tabId: 'x', name: 'x' })], [], null, marker)
    expect(asked).toEqual(['x'])
    expect(m.get('x')).toMatchObject({ via: 'marker', record: { sessionId: '' } })
  })
})

describe('registry', () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'cctabs-susp-'))
    try { fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  it('round-trips records, one file per session', () => {
    withDir((dir) => {
      writeRecord(rec(), dir)
      writeRecord(rec({ sessionId: ID2, name: 'beta' }), dir)
      expect(readRecords(dir).map((r) => r.name).sort()).toEqual(['alpha', 'beta'])
      expect(readdirSync(dir).sort()).toEqual([`${ID2}.json`, `${ID}.json`].sort())
      removeRecord(ID, dir)
      expect(readRecords(dir).map((r) => r.name)).toEqual(['beta'])
    })
  })

  it('skips malformed files rather than failing the whole registry', () => {
    withDir((dir) => {
      writeRecord(rec(), dir)
      writeFileSync(join(dir, 'junk.json'), '{not json')
      writeFileSync(join(dir, 'other.json'), JSON.stringify({ sessionId: '../../etc', name: 'x' }))
      expect(readRecords(dir).map((r) => r.sessionId)).toEqual([ID])
    })
  })

  it('refuses a non-UUID session id as a filename', () => {
    expect(() => recordPath('../../etc/passwd', '/r')).toThrow()
  })
})
