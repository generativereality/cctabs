export interface Block {
  blockid: string
  tabid: string
  view: string
  meta?: Record<string, string>
  /**
   * PID of the process in this terminal, when the backend can report one.
   *
   * This is the only honest liveness signal cctabs has. Reading scrollback
   * answers "has the backend captured any output for this tab", which is not
   * the same question and has already been mistaken for it. A tab with a pid
   * has a running process no matter how empty its buffer looks.
   *
   * `undefined` means either "no process" or "this backend doesn't report
   * pids", so callers must distinguish the two before acting on it.
   */
  pid?: number
}

export interface WorkspaceData {
  oid: string
  name: string
  tabids: string[]
}

export interface Workspace {
  workspacedata: WorkspaceData
  windowid: string
}

export interface Config {
  claude: {
    flags: string[]
  }
  defaults: {
    workspace: string
    /**
     * Prepended to every freshly-minted tab title AND `claude --name` (the
     * claude.ai remote-control session name). Per-install, empty by default.
     */
    prefix: string
  }
}

export interface AllData {
  blocks: Block[]
  tabsById: Map<string, Block[]>
  workspaces: Workspace[]
  tabNames: Map<string, string>
}

/**
 * - `active`   — a Claude turn is in flight.
 * - `idle`     — Claude is in the tab, waiting for input.
 * - `terminal` — a shell prompt, no Claude session.
 * - `unreadable` — no output could be read for this tab. Says nothing about
 *   whether a session is running; it was called `unknown` and reported as
 *   "dead", which is how a live session came to be closed and recreated.
 */
export type SessionStatus = 'active' | 'idle' | 'terminal' | 'unreadable'

/**
 * A permission mode cctabs is willing to hand back to `claude --permission-mode`.
 *
 * Exactly the values that flag accepts, minus `dontAsk`, which has no observed
 * UI pill to capture it from. Notably this is NOT the same set the session
 * transcript records: transcripts also contain `default`, which the flag
 * rejects, so a transcript value has to be validated rather than passed through.
 */
export type PermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'plan'
