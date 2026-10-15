import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  checkCapture, clearPending, defaultSuspendAge, pendingPath, readPending, stampedManifestPath,
  tabbyLifecycle, tabbyMainPids, tasklistShowsTabby, writePending, type PendingRestore,
} from './fleet-state.js'

describe('checkCapture', () => {
  it('accepts a capture that saw exactly the tabs the terminal has', () => {
    expect(checkCapture({ capturedTabIds: ['a', 'b'], liveTabIds: ['b', 'a'], errors: [] })).toEqual({ ok: true })
  })
  it('refuses when a read came back short — the 0-entry manifest of 2026-10-15', () => {
    const r = checkCapture({ capturedTabIds: [], liveTabIds: ['a', 'b'], errors: [] })
    expect(r.ok).toBe(false)
  })
  it('refuses when tabs changed mid-capture', () => {
    expect(checkCapture({ capturedTabIds: ['a', 'gone'], liveTabIds: ['a'], errors: [] }).ok).toBe(false)
  })
  it('refuses a fleet that would not restore cleanly, and says why', () => {
    const r = checkCapture({ capturedTabIds: ['a'], liveTabIds: ['a'], errors: ['dal: two tabs share this name'] })
    expect(r).toMatchObject({ ok: false })
    expect((r as { message: string }).message).toContain('dal: two tabs share this name')
  })
})

describe('pending restore marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cctabs-fleet-'))
  const p: PendingRestore = { manifest: '/x/manifest.json', savedAt: '2026-10-15T12:00:00.000Z', reason: 'reboot', sessions: 96, suspendOlderThan: '3d', noSession: ['OS default'] }
  it('round-trips, and clears', () => {
    expect(readPending(dir)).toBeNull()
    writePending(p, dir)
    expect(readPending(dir)).toEqual(p)
    clearPending(dir)
    expect(readPending(dir)).toBeNull()
  })
  it('reads a damaged marker as none rather than throwing', () => {
    writeFileSync(pendingPath(dir), '{"manifest":')
    expect(readPending(dir)).toBeNull()
  })
})

describe('stampedManifestPath', () => {
  it('is dated to the second, so a save never overwrites another', () => {
    expect(stampedManifestPath(new Date(2026, 9, 15, 14, 31, 5), '/d')).toBe('/d/manifest-20261015-143105.json')
  })
})

describe('defaultSuspendAge', () => {
  it('suspends idle sessions only for a large fleet', () => {
    expect(defaultSuspendAge(96)).toBe('3d')
    expect(defaultSuspendAge(30)).toBeUndefined()
  })
})

describe('tabbyMainPids', () => {
  const rows = (cmds: string[]) => cmds.map((command, i) => ({ pid: 100 + i, ppid: 1, command }))
  it('finds the macOS main process and not its helpers', () => {
    // Real command lines from this machine: the helpers' path has a space in
    // "Tabby Helper.app", so a first-word match ends in ".../Tabby" too.
    const r = rows([
      '/Applications/Tabby.app/Contents/MacOS/Tabby',
      '/Applications/Tabby.app/Contents/Frameworks/Tabby Helper.app/Contents/MacOS/Tabby Helper --type=utility',
      '/Applications/Tabby.app/Contents/Frameworks/Tabby Helper (Renderer).app/Contents/MacOS/Tabby Helper (Renderer) --type=renderer',
      '/Applications/Tabby.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
      'vim /Users/x/notes/Tabby.md',
    ])
    expect(tabbyMainPids(r, 'darwin')).toEqual([100])
  })
  it('finds the Linux main process and not the Electron children', () => {
    const r = rows(['/opt/Tabby/tabby', '/opt/Tabby/tabby --type=renderer --enable-sandbox', 'grep tabby'])
    expect(tabbyMainPids(r, 'linux')).toEqual([100])
  })
})

describe('tasklistShowsTabby', () => {
  it('reads tasklist output', () => {
    expect(tasklistShowsTabby('\r\nTabby.exe                    12345 Console                    1    210,000 K\r\n')).toBe(true)
    expect(tasklistShowsTabby('INFO: No tasks are running which match the specified criteria.\r\n')).toBe(false)
  })
})

describe('tabbyLifecycle', () => {
  it('quits gracefully everywhere — never a kill', () => {
    expect(tabbyLifecycle('darwin').quit).toEqual(['osascript', '-e', 'tell application "Tabby" to quit'])
    expect(tabbyLifecycle('win32').quit).not.toContain('/F')
    expect(tabbyLifecycle('linux').quit).toContain('-TERM')
  })
  it('reopens Windows and Linux from the path the running Tabby had', () => {
    expect(tabbyLifecycle('win32', 'C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\Programs\\\\Tabby\\\\Tabby.exe').open[0]).toContain('Tabby.exe')
    expect(tabbyLifecycle('darwin').open).toEqual(['open', '-a', 'Tabby'])
  })
})
