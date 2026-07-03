export interface Block {
  blockid: string
  tabid: string
  view: string
  meta?: Record<string, string>
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

export type SessionStatus = 'active' | 'idle' | 'terminal' | 'unknown'
