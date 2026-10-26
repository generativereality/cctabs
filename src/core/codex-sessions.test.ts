import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, win32 } from 'path'
import { codexResumeId, matchCodexTabs, readCodexSessions } from './codex-sessions.js'
import { codexLaunchBody } from './open-codex.js'
import { parseManifest } from './manifest.js'
import { placeholderClaudeLine } from './suspend.js'

const id = '12345678-1234-1234-1234-123456789abc'
const session = { id, cwd: '/scratch', startedAt: 1100, file: '/rollout.jsonl' }
const tabs = [{ tabId: 'a', name: 'renamed', shellPid: 10 }]
const rows = [{ pid: 10, ppid: 1, command: 'zsh' }, { pid: 11, ppid: 10, command: '/bin/codex hello', cwd: '/scratch', startedAt: 1000 }]

describe('Codex session identity', () => {
  test('reads id and session_id metadata, ignoring malformed files', () => {
    const root = mkdtempSync(join(tmpdir(), 'cctabs-codex-'))
    try {
      mkdirSync(join(root, '2026'))
      writeFileSync(join(root, '2026', 'rollout-one.jsonl'), JSON.stringify({ type: 'session_meta', timestamp: '2026-10-16T10:00:00Z', payload: { id, cwd: '/scratch', forked_from_id: 'parent-id' } }) + '\n' + 'large conversation')
      writeFileSync(join(root, 'rollout-bad.jsonl'), '{')
      expect(readCodexSessions(root).map((s) => s.id)).toEqual([id])
      expect(readCodexSessions(root)[0].forkedFromId).toBe('parent-id')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('matches shell descendants, independently of tab name', () => {
    expect(matchCodexTabs(tabs, rows, [session]).get('a')?.id).toBe(id)
    expect(matchCodexTabs([{ ...tabs[0], shellPid: 99 }], rows, [session]).size).toBe(0)
  })
  test('resume argv is exact even without rollout or cwd', () => {
    expect(codexResumeId(`codex resume -m gpt ${id}`)).toBe(id)
    expect(codexResumeId(`codex ${id}`)).toBeUndefined()
    expect(codexResumeId(`zsh -c codex resume ${id}`)).toBeUndefined()
    expect(matchCodexTabs(tabs, [rows[0], { ...rows[1], command: `codex resume ${id}` }], []).get('a')?.id).toBe(id)
  })
  test('refuses old, multiple, wrong-directory and shared candidates', () => {
    expect(matchCodexTabs(tabs, rows, [{ ...session, startedAt: 999 }]).get('a')?.id).toBeUndefined()
    expect(matchCodexTabs(tabs, rows, [session, { ...session, id: 'other' }]).get('a')?.id).toBeUndefined()
    expect(matchCodexTabs(tabs, rows, [{ ...session, cwd: '/other' }]).get('a')?.id).toBeUndefined()
    const two = [...tabs, { tabId: 'b', name: 'b', shellPid: 20 }]
    const procs = [...rows, { ...rows[1], pid: 21, ppid: 20 }]
    expect([...matchCodexTabs(two, procs, [session]).values()].every((m) => !m.id)).toBe(true)
  })
  test('tabs opened one after another in one folder each get their own rollout', () => {
    // The demo rehearsal's timings, 2026-10-26: four fresh Codex tabs in one repo,
    // started 3s apart (ps reports whole seconds), each rollout created ~0.7s in.
    const starts = [22_000, 25_000, 28_000, 31_000]
    const created = [22_750, 25_572, 28_709, 32_109]
    const ids = created.map((_, i) => `0000000${i}-1234-1234-1234-123456789abc`)
    const four = starts.map((_, i) => ({ tabId: `t${i}`, name: `t${i}`, shellPid: 100 + i * 10 }))
    const procs = starts.flatMap((startedAt, i) => [
      { pid: 100 + i * 10, ppid: 1, command: 'zsh' },
      { pid: 101 + i * 10, ppid: 100 + i * 10, command: '/bin/codex -C /repo hi', cwd: '/repo', startedAt },
    ])
    const rollouts = created.map((startedAt, i) => ({ id: ids[i], cwd: '/repo', startedAt, file: `/r${i}.jsonl` }))
    const got = matchCodexTabs(four, procs, rollouts)
    expect(four.map((t) => got.get(t.tabId)?.id)).toEqual(ids)
    // Two launches in the same second cannot be told apart: still no guess.
    const sameSecond = procs.map((r) => r.pid === 111 ? { ...r, startedAt: 22_000 } : r)
    const unsure = matchCodexTabs(four, sameSecond, rollouts)
    expect(unsure.get('t0')?.id).toBeUndefined()
    expect(unsure.get('t1')?.id).toBeUndefined()
    // A rollout late enough to land in the next tab's window: that window holds
    // two and the first holds none, so neither tab is guessed.
    const late = rollouts.map((r, i) => i === 0 ? { ...r, startedAt: 25_100 } : r)
    const lateGot = matchCodexTabs(four, procs, late)
    expect(lateGot.get('t0')?.id).toBeUndefined()
    expect(lateGot.get('t1')?.id).toBeUndefined()
    expect(lateGot.get('t2')?.id).toBe(ids[2])
  })
  test('manifest and placeholder preserve engine', () => {
    const entry = parseManifest(JSON.stringify([{ name: 'cx', cwd: '/scratch', engine: 'codex', session_id: id, suspended: true }]))[0]
    expect(entry.engine).toBe('codex')
    expect(entry.suspended).toBe(true)
    expect(placeholderClaudeLine({ engine: entry.engine, sessionId: id, name: 'cx', dir: '/scratch', extraFlags: [], recordFile: '/record' })).toBe(`codex 'resume' '-C' '/scratch' '${id}'`)
  })
})

test('Windows launch keeps hostile argv out of cmd and round-trips through encoded bootstrap', () => {
  const prompt = 'quotes " and \' %PATH% ^ & | ! bang\nsecond\r\nline \\ trailing\\'
  const body = codexLaunchBody({ prompt, extraFlags: [] }, { posix: false })
  expect(body).not.toContain(prompt)
  // Real Tabby on Windows preserves embedded double quotes in Node -e.
  // A quoted bootstrap then evaluates a string literal and silently exits.
  expect(body).not.toContain('"')
  const encoded = /Buffer.from\('([A-Za-z0-9+/=]+)'/.exec(body)![1]
  const script = Buffer.from(encoded, 'base64').toString()
  let childArgs: string[] = []
  const fakeRequire = (mod: string) => mod === 'node:child_process' ? { spawnSync: (cmd: string, args: string[]) => {
    if (cmd === 'where.exe') return { stdout: 'C:\\npm\\codex.cmd\r\nC:\\other\\codex.cmd\r\n' }
    childArgs = args
    return { status: 0 }
  } } : mod === 'node:fs' ? { existsSync: (file: string) => { expect(file).toBe('C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'); return true } } : win32
  new Function('require', 'process', script)(fakeRequire, { execPath: 'node.exe', exit: () => {} })
  expect(childArgs.at(-1)).toBe(prompt)
})

test('a Codex child tool under Claude does not become the terminal engine', () => {
  const nested = [rows[0], { pid: 12, ppid: 10, command: 'claude' }, { ...rows[1], ppid: 12 }]
  expect(matchCodexTabs(tabs, nested, [session]).size).toBe(0)
})

test('Windows Git Bash keeps prompt data out of its script and supports a native Codex exe', () => {
  const prompt = 'quotes " and \' %PATH% ^ & | !\r\ntrailing \\\\'
  const body = codexLaunchBody({ prompt, extraFlags: [] }, { posix: true }, 'win32')
  expect(body).not.toContain(prompt)
  expect(body).not.toContain('"')
  expect(body).toStartWith("node -e 'eval(Buffer.from(`")
  const encoded = /[A-Za-z0-9+/]{80,}={0,2}/.exec(body)![0]
  let command: string | undefined
  let argv: string[] = []
  const fakeRequire = (mod: string) => mod === 'node:child_process' ? { spawnSync: (cmd: string, args: string[]) => {
    if (cmd === 'where.exe') return { stdout: args[0] === 'codex.exe' ? 'C:\\native path\\codex.exe\r\n' : '' }
    command = cmd
    argv = args
    return { status: 0 }
  } } : mod === 'node:fs' ? { existsSync: () => false } : win32
  new Function('require', 'process', Buffer.from(encoded, 'base64').toString())(fakeRequire, { execPath: 'node.exe', exit: () => {} })
  expect(command).toBe('C:\\native path\\codex.exe')
  expect(argv).toEqual([prompt])
})

test('macOS POSIX launches keep using the installed codex command directly', () => {
  expect(codexLaunchBody({ prompt: 'hello', extraFlags: [] }, { posix: true }, 'darwin')).toBe("codex 'hello'")
})

test('a fork is matched to its new rollout without making its fresh source ambiguous', () => {
  const source = { id: '11111111-1111-1111-1111-111111111111', cwd: '/tmp', startedAt: 1100, file: 'source' }
  const fork = { id: '22222222-2222-2222-2222-222222222222', cwd: '/tmp', startedAt: 2100, file: 'fork', forkedFromId: source.id }
  const rows = [
    { pid: 10, ppid: 1, command: 'codex hello', cwd: '/tmp', startedAt: 1000 },
    { pid: 20, ppid: 1, command: `codex fork -m test ${source.id}`, cwd: '/tmp', startedAt: 2000 },
  ]
  const matches = matchCodexTabs([{ tabId: 'source', name: '', shellPid: 10 }, { tabId: 'fork', name: '', shellPid: 20 }], rows, [source, fork])
  expect(matches.get('source')?.id).toBe(source.id)
  expect(matches.get('fork')?.id).toBe(fork.id)
  expect(matches.get('fork')?.id).not.toBe(source.id)
})
