import { describe, expect, it } from 'bun:test'
import { agentBashResult, AGENT_BASH_CHECK, lastLine } from './doctor.js'

describe('agentBashResult', () => {
  it('passes when bash is already on PATH', () => {
    const r = agentBashResult('C:\\Program Files\\Git\\bin\\bash.exe', undefined)
    expect(r.status).toBe('ok')
    expect(r.name).toBe(AGENT_BASH_CHECK)
    expect(r.hint).toBeUndefined()
  })

  // The whole point of the check: cctabs works, Claude Code quietly does not,
  // so the hint has to name the consequence AND the exact directory to add.
  it('names the directory to add when Git Bash exists but is not on PATH', () => {
    const r = agentBashResult(undefined, 'C:\\Program Files\\Git\\bin\\bash.exe')
    expect(r.status).toBe('warn')
    expect(r.detail).toContain('not on PATH')
    expect(r.hint).toContain('C:\\Program Files\\Git\\bin')
    expect(r.hint).toContain('setx PATH')
    expect(r.hint).toContain('Bash allowlist')
  })

  it('tells you to install Git when there is no bash at all', () => {
    const r = agentBashResult(undefined, undefined)
    expect(r.status).toBe('warn')
    expect(r.hint).toContain('Install Git for Windows')
    expect(r.hint).not.toContain('setx')
  })

  it('never reports failure — cctabs itself is unaffected', () => {
    for (const r of [
      agentBashResult(undefined, undefined),
      agentBashResult(undefined, 'C:\\Git\\bin\\bash.exe'),
    ]) expect(r.status).not.toBe('fail')
  })
})

describe('lastLine', () => {
  // Seen on macOS Terminal: the login shell's banner arrived first and the
  // check reported "Restored session: …" as where claude lives.
  it('skips a banner the login shell printed before the answer', () => {
    expect(lastLine('Restored session: Wed 23 Sep 2026\n/Users/x/.local/bin/claude\n'))
      .toBe('/Users/x/.local/bin/claude')
  })

  it('handles CRLF and a bare answer', () => {
    expect(lastLine('C:\\Git\\bin\\bash.exe\r\n')).toBe('C:\\Git\\bin\\bash.exe')
  })
})
