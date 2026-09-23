import { describe, it, expect } from 'bun:test'
import { auditRestart, entriesToRestore, planRestart, type RestartInputs } from './restart-plan.js'
import type { RestoreEntry } from './restore-plan.js'

const e = (name: string, sessionId?: string): RestoreEntry => ({ name, dir: `/w/${name}`, sessionId })

function inputs(over: Partial<RestartInputs> = {}): RestartInputs {
  return {
    liveSessionPids: new Map(),
    shellPidClaude: new Map(),
    nameOnly: new Set(),
    selfPids: new Set([1000, 999]),
    ...over,
  }
}

describe('planRestart', () => {
  it('targets the Claude whose argv resumes the entry\'s id', () => {
    const plan = planRestart([e('a', 'S1')], inputs({ liveSessionPids: new Map([['S1', [11]]]) }))
    expect(plan.targets).toEqual([{ entry: e('a', 'S1'), pids: [11], via: 'argv' }])
  })

  it('targets a fresh-launched Claude only through the exact shell-pid route', () => {
    const plan = planRestart([e('a', 'S1')], inputs({ shellPidClaude: new Map([['S1', 12]]) }))
    expect(plan.targets[0]).toMatchObject({ pids: [12], via: 'shell-pid' })
  })

  it('leaves a Claude matched only by --name for a human — that is a guess', () => {
    const plan = planRestart([e('a', 'S1')], inputs({ nameOnly: new Set(['S1']) }))
    expect(plan.targets).toEqual([])
    expect(plan.handOnly.map((x) => x.name)).toEqual(['a'])
  })

  it('never targets our own process tree, whatever the manifest says', () => {
    const plan = planRestart([e('me', 'S1')], inputs({ liveSessionPids: new Map([['S1', [999]]]) }))
    expect(plan.targets).toEqual([])
    expect(plan.protected.map((x) => x.name)).toEqual(['me'])
  })

  it('stops every process on a session that two Claudes are running', () => {
    const plan = planRestart([e('a', 'S1')], inputs({ liveSessionPids: new Map([['S1', [11, 21]]]) }))
    expect(plan.targets[0].pids).toEqual([11, 21])
  })

  it('does not touch an entry with no session id — its context could not come back', () => {
    const plan = planRestart([e('fresh')], inputs())
    expect(plan.noSession.map((x) => x.name)).toEqual(['fresh'])
  })

  it('lists a session with no running Claude for restore, with nothing to stop', () => {
    const plan = planRestart([e('down', 'S9')], inputs())
    expect(plan.notRunning.map((x) => x.name)).toEqual(['down'])
    expect(entriesToRestore(plan).map((x) => x.name)).toEqual(['down'])
  })

  it('does not restore a target that refused to stop', () => {
    const plan = planRestart([e('a', 'S1'), e('b', 'S2')], inputs({ liveSessionPids: new Map([['S1', [11]], ['S2', [12]]]) }))
    const stuck = new Set([plan.targets[0].entry])
    expect(entriesToRestore(plan, stuck).map((x) => x.name)).toEqual(['b'])
  })
})

describe('auditRestart', () => {
  it('is relative to the manifest: a fresh tab elsewhere is not a failure', () => {
    // Only the entries this restart restored are checked; nothing else on the
    // machine is counted.
    const r = auditRestart([e('a', 'S1')], new Map([['S1', [11]]]))
    expect(r.ok.map((x) => x.name)).toEqual(['a'])
    expect(r.missing).toEqual([])
  })

  it('names a tab that came back without its session', () => {
    const r = auditRestart([e('a', 'S1'), e('b', 'S2')], new Map([['S1', [11]]]))
    expect(r.missing.map((x) => x.name)).toEqual(['b'])
  })

  it('names a session that came back twice', () => {
    const r = auditRestart([e('a', 'S1')], new Map([['S1', [11, 12]]]))
    expect(r.doubled.map((x) => x.name)).toEqual(['a'])
  })
})
