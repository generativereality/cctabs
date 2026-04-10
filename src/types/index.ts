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
  }
}

export interface AllData {
  blocks: Block[]
  tabsById: Map<string, Block[]>
  workspaces: Workspace[]
  tabNames: Map<string, string>
}

export type SessionStatus = 'active' | 'idle' | 'terminal' | 'unknown'
