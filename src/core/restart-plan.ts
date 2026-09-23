import type { RestoreEntry } from './restore-plan.js'

/**
 * Planning half of `cctabs restart`: which pid to stop for which entry.
 *
 * The rule that governs all of it is **never signal a process you cannot tie
 * to an entry exactly**. Stopping the wrong Claude loses a turn in flight;
 * stopping one whose session we can't name loses its context for good, since
 * restore would then start it fresh. So a pid is taken only from:
 *
 *   - `argv` — a live Claude launched with `--resume <entry's id>`. Exact.
 *   - `shell-pid` — the Claude under the tab's own shell (`stable-pid`), in a
 *     tab whose session resolved to the entry's id. Exact.
 *
 * A Claude matched only by its spawn-time `--name` is a guess and is left
 * alone, reported as "restart by hand". Pure.
 */

export interface RestartTarget {
  entry: RestoreEntry
  pids: number[]
  via: 'argv' | 'shell-pid'
}

export interface RestartPlan {
  /** Stop these, then restore them. */
  targets: RestartTarget[]
  /** Have a session but no running Claude: restore brings them up, nothing to stop. */
  notRunning: RestoreEntry[]
  /** Running, but not tied to a pid exactly — left alone. */
  handOnly: RestoreEntry[]
  /** No session id: restarting would lose the context, so left alone. */
  noSession: RestoreEntry[]
  /** Would have meant signalling our own process tree. Left alone. */
  protected: RestoreEntry[]
}

export interface RestartInputs {
  /** Session id → pids of Claudes launched on it (from argv). */
  liveSessionPids: Map<string, number[]>
  /** Session id → the Claude pid found under that tab's own shell. */
  shellPidClaude: Map<string, number>
  /** Session ids whose tab has a Claude matched only by `--name`. */
  nameOnly: Set<string>
  /** Our own pid and every ancestor — never signalled. */
  selfPids: Set<number>
}

export function planRestart(entries: RestoreEntry[], inputs: RestartInputs): RestartPlan {
  const plan: RestartPlan = { targets: [], notRunning: [], handOnly: [], noSession: [], protected: [] }

  for (const entry of entries) {
    const id = entry.sessionId
    if (!id) {
      plan.noSession.push(entry)
      continue
    }

    const fromArgv = inputs.liveSessionPids.get(id) ?? []
    const fromShell = inputs.shellPidClaude.get(id)
    const pids = [...new Set([...fromArgv, ...(fromShell !== undefined ? [fromShell] : [])])]

    if (pids.some((pid) => inputs.selfPids.has(pid))) {
      plan.protected.push(entry)
      continue
    }
    if (pids.length) {
      plan.targets.push({ entry, pids, via: fromArgv.length ? 'argv' : 'shell-pid' })
      continue
    }
    if (inputs.nameOnly.has(id)) {
      plan.handOnly.push(entry)
      continue
    }
    plan.notRunning.push(entry)
  }

  return plan
}

/** Entries whose session should be running once the restart is done. */
export function entriesToRestore(plan: RestartPlan, stillRunning: Set<RestoreEntry> = new Set()): RestoreEntry[] {
  return [...plan.targets.map((t) => t.entry).filter((e) => !stillRunning.has(e)), ...plan.notRunning]
}

/**
 * The post-restart audit, relative to the manifest rather than the machine.
 *
 * The hand-rolled check was "count every Claude without `--resume`, must be 0"
 * — which reads 1 the moment any tab has been opened fresh, including the one
 * driving the restart. What actually matters is narrower and exact: every
 * entry this restart was meant to bring back has a live Claude launched on its
 * id. One that doesn't is the dangerous case — a tab that looks running but
 * came back EMPTY, replayed without `--resume`. Pure.
 */
export function auditRestart(restored: RestoreEntry[], liveSessionPids: Map<string, number[]>): {
  ok: RestoreEntry[]
  missing: RestoreEntry[]
  doubled: RestoreEntry[]
} {
  const out = { ok: [] as RestoreEntry[], missing: [] as RestoreEntry[], doubled: [] as RestoreEntry[] }
  for (const e of restored) {
    const pids = e.sessionId ? liveSessionPids.get(e.sessionId) ?? [] : []
    if (!pids.length) out.missing.push(e)
    else if (pids.length > 1) out.doubled.push(e)
    else out.ok.push(e)
  }
  return out
}
