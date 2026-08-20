import type { TerminalAdapter } from './adapter.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True while a pid exists and we're allowed to signal it. */
function pidAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface TabExitResult {
  /** The tab is gone from the terminal's tab list. */
  tabGone: boolean
  /** The process that was running in it is gone too. */
  processGone: boolean
}

/**
 * Wait until a tab is closed *and* the process that was in it has actually
 * exited.
 *
 * Closing a tab is not the same event as its process finishing, and the gap is
 * long enough to lose data in. A closing Claude Code writes a metadata trailer
 * — `custom-title`, `agent-name`, `permission-mode` — to its transcript path on
 * the way out. Anything that closes a tab and then immediately moves that
 * transcript will find the trailer recreated at the old path a moment later,
 * with a fresh mtime and a `customTitle`: exactly the artefact that shadows the
 * session on the next resolve.
 *
 * So both halves are checked. The tab disappearing is the terminal's answer;
 * the pid disappearing is the process's, and it is the one that matters. Returns
 * what was actually observed rather than throwing, so callers can decide
 * whether to proceed or bail.
 */
export async function waitForTabExit(
  adapter: TerminalAdapter,
  tabId: string,
  pid?: number,
  timeoutMs = 20_000,
  pollMs = 250,
): Promise<TabExitResult> {
  const deadline = Date.now() + timeoutMs
  let tabGone = false

  while (Date.now() < deadline) {
    if (!tabGone) {
      tabGone = !adapter.blocksList().some((b) => b.tabid === tabId || b.blockid === tabId)
    }
    // No pid to watch (backend doesn't report one, or there was no process):
    // the tab vanishing is all the evidence available.
    if (tabGone && (pid === undefined || !pidAlive(pid))) {
      return { tabGone: true, processGone: true }
    }
    await sleep(pollMs)
  }

  return {
    tabGone,
    processGone: pid === undefined ? tabGone : !pidAlive(pid),
  }
}
