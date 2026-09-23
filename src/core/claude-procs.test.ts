import { describe, it, expect } from 'bun:test'
import {
  ancestorsOf,
  claudeProcsOf,
  descendantsOf,
  isClaudeCommand,
  liveSessionPids,
  matchTabsToClaude,
  ownClaudeProc,
  parseClaudeArgs,
  parseProcessTable,
} from './claude-procs.js'

const A = 'aaaaaaaa-1111-4111-8111-111111111111'
const B = 'bbbbbbbb-2222-4222-8222-222222222222'

// Shaped like a real Tabby fleet: Tabby → login shell → claude → helper.
const PS = `
  100     1 /Applications/Tabby.app/Contents/MacOS/Tabby
  200   100 /bin/zsh -l -i -c claude '--model' 'opus' --resume ${A} --name "alpha"; exec '/bin/zsh' -l -i
  201   200 claude --model opus --resume ${A} --name alpha
  202   201 caffeinate -i -t 300
  300   100 /bin/zsh -l -i -c claude --name "beta tab"; exec '/bin/zsh' -l -i
  301   300 claude --name beta tab --permission-mode plan
  302   301 /bin/zsh -c cctabs whoami
  303   302 node /usr/local/bin/cctabs whoami
  400   100 /bin/zsh -l -i
  401   400 /opt/homebrew/bin/claude -r ${B.toUpperCase()} --name=gamma
garbage line
`

describe('parseProcessTable', () => {
  it('reads pid, ppid and the full command, skipping lines that are not rows', () => {
    const rows = parseProcessTable(PS)
    expect(rows).toHaveLength(10)
    expect(rows[1]).toEqual({ pid: 200, ppid: 100, command: expect.stringContaining('exec') })
  })
})

describe('isClaudeCommand', () => {
  it('is decided by argv[0], so the tab shell that mentions claude is not counted', () => {
    expect(isClaudeCommand('claude --resume x')).toBe(true)
    expect(isClaudeCommand('/opt/homebrew/bin/claude')).toBe(true)
    expect(isClaudeCommand(`/bin/zsh -l -i -c claude --resume ${A}`)).toBe(false)
    expect(isClaudeCommand('claude-helper --x')).toBe(false)
  })
})

describe('parseClaudeArgs', () => {
  it('takes --resume, -r and --name=, lowercasing ids', () => {
    expect(parseClaudeArgs(`claude --resume ${A} --name alpha`)).toEqual({ resumeId: A, name: 'alpha' })
    expect(parseClaudeArgs(`claude -r ${B.toUpperCase()} --name=gamma`)).toEqual({ resumeId: B, name: 'gamma' })
  })

  it('reads a multi-word --name up to the next flag, because ps drops the quoting', () => {
    expect(parseClaudeArgs('claude --name beta tab --permission-mode plan').name).toBe('beta tab')
  })

  it('refuses a non-UUID after --resume — bare --resume opens a picker', () => {
    expect(parseClaudeArgs('claude --resume --name x').resumeId).toBeUndefined()
    expect(parseClaudeArgs('claude --resume notes').resumeId).toBeUndefined()
  })

  it('reads --session-id as a separate field', () => {
    expect(parseClaudeArgs(`claude --session-id ${A}`)).toEqual({ sessionIdArg: A })
  })
})

describe('process tree helpers', () => {
  const rows = parseProcessTable(PS)

  it('walks ancestors up to the root', () => {
    expect(ancestorsOf(303, rows)).toEqual([303, 302, 301, 300, 100])
  })

  it('lists descendants breadth-first', () => {
    expect(descendantsOf(300, rows).map((r) => r.pid)).toEqual([301, 302, 303])
  })

  it('finds the Claude we are running under, and only that one', () => {
    expect(ownClaudeProc(rows, 303)?.pid).toBe(301)
    expect(ownClaudeProc(rows, 400)).toBeUndefined()
  })

  it('maps live session ids to the Claude pids that launched them — never the shell', () => {
    const live = liveSessionPids(rows)
    expect(live.get(A)).toEqual([201])
    expect(live.get(B)).toEqual([401])
    expect(live.size).toBe(2)
  })

  it('finds three Claude processes, not six', () => {
    expect(claudeProcsOf(rows).map((p) => p.pid)).toEqual([201, 301, 401])
  })
})

describe('matchTabsToClaude', () => {
  const rows = parseProcessTable(PS)

  it('matches exactly by shell pid when the backend reports one', () => {
    const m = matchTabsToClaude([{ tabId: 't1', name: 'renamed-since', shellPid: 200 }], rows)
    expect(m.get('t1')).toEqual({ proc: expect.objectContaining({ pid: 201 }), via: 'shell-pid' })
  })

  it('falls back to a unique --name when there is no shell pid', () => {
    const m = matchTabsToClaude([{ tabId: 't3', name: 'gamma' }], rows)
    expect(m.get('t3')?.proc.pid).toBe(401)
    expect(m.get('t3')?.via).toBe('argv-name')
  })

  it('does not fall back by name for a tab that reported a shell pid with no Claude under it', () => {
    const m = matchTabsToClaude([{ tabId: 't4', name: 'gamma', shellPid: 400 }], rows)
    expect(m.get('t4')?.proc.pid).toBe(401) // 401 IS under 400 — exact route
    const none = matchTabsToClaude([{ tabId: 't5', name: 'gamma', shellPid: 999 }], rows)
    expect(none.has('t5')).toBe(false)
  })

  it('refuses a name shared by two tabs or two processes rather than guess', () => {
    const twoTabs = matchTabsToClaude([{ tabId: 'x', name: 'gamma' }, { tabId: 'y', name: 'gamma' }], rows)
    expect(twoTabs.size).toBe(0)

    const dupRows = parseProcessTable(`${PS}\n  501   100 claude --resume ${A} --name gamma\n`)
    const twoProcs = matchTabsToClaude([{ tabId: 'z', name: 'gamma' }], dupRows)
    expect(twoProcs.size).toBe(0)
  })

  it('never uses a stale argv name to pair a renamed tab with a different process', () => {
    // Tab now called "alpha-2"; the process still says "alpha". No match by name.
    const m = matchTabsToClaude([{ tabId: 't1', name: 'alpha-2' }], rows)
    expect(m.size).toBe(0)
  })
})
