import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TerminalAdapter } from '../core/adapter.js'
import type { AllData, Block, SessionStatus } from '../types/index.js'
import { planRestore, type PlannedEntry, type RestoreAction, type RestoreEntry } from '../core/restore-plan.js'
import { DEFAULT_CONFIG_ROOT, type ClaudeConfigDir } from '../core/config-dirs.js'
import { launchEnvFor } from '../core/backends.js'
import { pathToProjectSlug } from '../core/session.js'
import { buildPlanDeps, buildResumeCommand, describeDecision, summarizeDecision } from './restore.js'

/**
 * An adapter that answers reads and throws on every mutation.
 *
 * This is the dry-run guarantee under test: `--dry` runs the exact same
 * planning wiring a real restore does, so if planning could mutate anything,
 * these calls would blow up here.
 */
function stubAdapter(tabs: Array<{ id: string; name: string; status: SessionStatus }>): {
  adapter: TerminalAdapter
  tabsById: Map<string, Block[]>
  tabNames: Map<string, string>
} {
  const tabsById = new Map<string, Block[]>(
    tabs.map((t) => [t.id, [{ blockid: `block-${t.id}`, tabid: t.id, view: 'term' }]]),
  )
  const tabNames = new Map<string, string>(tabs.map((t) => [t.id, t.name]))
  const statusById = new Map(tabs.map((t) => [`block-${t.id}`, t.status]))
  const mutation = (name: string) => () => {
    throw new Error(`planning must not mutate: ${name}`)
  }

  const adapter: TerminalAdapter = {
    getAllData: async (): Promise<AllData> => ({ blocks: [], tabsById, workspaces: [], tabNames }),
    closeSocket: () => {},
    blocksList: () => [...tabsById.values()].flat(),
    scrollback: () => '',
    confirmScrollbackEmpty: async () => true,
    detectSessionStatus: (blockId) => statusById.get(blockId) ?? 'unreadable',
    deleteBlock: mutation('deleteBlock'),
    newTab: mutation('newTab'),
    waitForNewBlock: mutation('waitForNewBlock'),
    renameTab: mutation('renameTab'),
    sendInput: mutation('sendInput'),
    openTabDirect: mutation('openTabDirect'),
    reorderTabs: mutation('reorderTabs'),
    resolveTab: (query, byId, names, opts) => {
      const q = query.toLowerCase()
      const ids = [...byId.keys()]
      const exact = ids.filter((tid) => (names.get(tid) ?? '').toLowerCase() === q)
      if (exact.length || opts?.exact) return exact
      return ids.filter((tid) => (names.get(tid) ?? '').toLowerCase().startsWith(q))
    },
    resolveBlock: () => [],
    resolveWorkspace: () => [],
    currentTabId: () => 'current',
    currentBlockId: () => 'block-current',
    currentWorkspaceId: () => 'ws',
  }
  return { adapter, tabsById, tabNames }
}

describe('buildPlanDeps', () => {
  it('plans against a live adapter without mutating anything', async () => {
    const { adapter, tabsById, tabNames } = stubAdapter([
      { id: 't1', name: 'alpha', status: 'terminal' },
      { id: 't2', name: 'beta', status: 'active' },
    ])

    const plan = await planRestore(
      // A directory with no Claude project dir behind it, so session lookup
      // resolves to "none" without touching the user's real sessions.
      [{ name: 'alpha', dir: '/nonexistent/cctabs-test' }, { name: 'beta', dir: '/nonexistent/cctabs-test' }],
      buildPlanDeps(adapter, {
        tabsById,
        tabNames,
        scopeTabIds: new Set(tabsById.keys()),
        currentTabId: 'current',
        createMissing: false,
      }),
    )

    expect(plan.map((p) => p.action)).toEqual(['no-session', 'already-running'])
  })

  it('matches tabs by exact name only, so a longer-named neighbour is not "already there"', async () => {
    const { adapter, tabsById, tabNames } = stubAdapter([
      { id: 't1', name: 'gapminder-login', status: 'active' },
    ])
    const deps = buildPlanDeps(adapter, {
      tabsById,
      tabNames,
      scopeTabIds: new Set(tabsById.keys()),
      currentTabId: 'current',
      createMissing: false,
    })
    expect(deps.matchTabs('gapminder')).toEqual([])
    expect(deps.matchTabs('gapminder-login')).toEqual(['t1'])
  })
})

const ALL_ACTIONS: RestoreAction[] = [
  'current-tab',
  'already-running',
  'ambiguous',
  'no-terminal',
  'no-session',
  'attach',
  'recreate',
  'duplicate',
  'spawn',
  'missing',
]

/** Actions a real run actually carries out; everything else is just reported. */
const EXECUTED: RestoreAction[] = ['attach', 'recreate', 'spawn']

const planned = (action: RestoreAction, extra: Partial<PlannedEntry> = {}): PlannedEntry => ({
  entry: { name: 'alpha', dir: '/dir/alpha' },
  action,
  sessionId: 'abcdef0123456789',
  dir: '/dir/alpha',
  ...extra,
})

describe('restore output parity', () => {
  it('describes and summarises every action', () => {
    for (const action of ALL_ACTIONS) {
      for (const dry of [true, false]) {
        expect(describeDecision(planned(action), dry)).toBeTruthy()
        expect(summarizeDecision(planned(action), dry)).toBeTruthy()
      }
    }
  })

  it('reports skipped entries identically in a dry run and a real one', () => {
    for (const action of ALL_ACTIONS.filter((a) => !EXECUTED.includes(a))) {
      const p = planned(action)
      // The duplicate line is only conditional on whether a tab gets closed.
      if (action === 'duplicate') continue
      expect(summarizeDecision(p, true)).toBe(summarizeDecision(p, false))
      expect(describeDecision(p, true)).toBe(describeDecision(p, false))
    }
  })

  it('marks the entries a real run would act on as dry-run decisions', () => {
    for (const action of EXECUTED) {
      const p = planned(action)
      expect(summarizeDecision(p, true)).toStartWith('dry run:')
      expect(summarizeDecision(p, false)).not.toStartWith('dry run:')
      expect(describeDecision(p, true)).toContain('would')
    }
  })

  it('says it would close a duplicate tab only when a real run would close it', () => {
    const closes = planned('duplicate', { closeTabId: 't2' })
    expect(summarizeDecision(closes, true)).toBe('dry run: close duplicate empty tab')
    expect(summarizeDecision(closes, false)).toBe('duplicate empty tab — closed')

    const keeps = planned('duplicate')
    expect(summarizeDecision(keeps, true)).toBe(summarizeDecision(keeps, false))
  })

  it('names the session it would resume', () => {
    expect(describeDecision(planned('attach'), true)).toContain('abcdef01…')
    expect(describeDecision(planned('spawn', { sessionId: undefined }), true)).toContain('fresh')
  })
})

/**
 * End-to-end through restore's own session resolution: a manifest that carries
 * nothing but a session id must still relaunch that session in the Claude
 * config dir it actually lives in. Getting this wrong is silent — the id isn't
 * in the default config dir, so `claude --resume` opens a fresh conversation.
 */
describe('restore session origin', () => {
  let defaultRoot: string
  let altRoot: string
  let repo: string
  let dirs: ClaudeConfigDir[]
  const SESSION_ID = 'c1ae54cf-728b-40e5-a4a1-c34ac017968b'

  beforeEach(() => {
    defaultRoot = mkdtempSync(join(tmpdir(), 'cctabs-default-'))
    altRoot = mkdtempSync(join(tmpdir(), 'cctabs-alt-'))
    repo = mkdtempSync(join(tmpdir(), 'cctabs-repo-'))
    dirs = [
      { root: DEFAULT_CONFIG_ROOT, projectsRoot: join(defaultRoot, 'projects') },
      // A preset name deliberately absent from any real config.toml, so the
      // assertions below don't depend on this machine's presets.
      { root: altRoot, projectsRoot: join(altRoot, 'projects'), backend: 'test-account' },
    ]
  })

  afterEach(() => {
    for (const d of [defaultRoot, altRoot, repo]) rmSync(d, { recursive: true, force: true })
  })

  function writeSession(projectsRoot: string, id: string, title: string): void {
    const projectDir = join(projectsRoot, pathToProjectSlug(repo))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(
      join(projectDir, `${id}.jsonl`),
      [
        JSON.stringify({ type: 'summary', customTitle: title }),
        JSON.stringify({ type: 'user', cwd: repo, message: { role: 'user', content: 'hi' } }),
      ].join('\n') + '\n',
    )
  }

  async function planFor(entry: RestoreEntry): Promise<PlannedEntry> {
    const { adapter, tabsById, tabNames } = stubAdapter([])
    const plan = await planRestore(
      [entry],
      buildPlanDeps(adapter, {
        tabsById,
        tabNames,
        scopeTabIds: new Set(),
        currentTabId: 'current',
        createMissing: true,
        sessionScope: dirs,
      }),
    )
    return plan[0]
  }

  it('never plans a plain no-backend spawn for an id that only exists in a non-default config dir', async () => {
    writeSession(join(altRoot, 'projects'), SESSION_ID, 'gapminder-login')

    // A manifest that says nothing about accounts — the shape `sessions --json`
    // emitted before it learned to record one.
    const p = await planFor({ name: 'gapminder-login', dir: repo, sessionId: SESSION_ID })

    expect(p.action).toBe('spawn')
    expect(p.sessionId).toBe(SESSION_ID)
    expect(p.backend).toBe('test-account')
    expect(p.configDir).toBe(altRoot)
    // …and that survives into the launch env, which is what actually matters.
    expect(launchEnvFor(p.backend, p.configDir).env?.CLAUDE_CONFIG_DIR).toBe(altRoot)
    expect(describeDecision(p, true)).toContain('[backend: test-account]')
  })

  it('infers the account from the name alone, with no session id at all', async () => {
    writeSession(join(altRoot, 'projects'), SESSION_ID, 'gapminder-login')
    const p = await planFor({ name: 'gapminder-login', dir: repo })
    expect(p).toMatchObject({ action: 'spawn', sessionId: SESSION_ID, backend: 'test-account' })
  })

  it('leaves a default-config-dir session with no env at all', async () => {
    const id = 'aaaaaaaa-0000-0000-0000-00000000000c'
    writeSession(join(defaultRoot, 'projects'), id, 'plain')
    const p = await planFor({ name: 'plain', dir: repo, sessionId: id })
    expect(p.backend).toBeUndefined()
    expect(p.configDir).toBeUndefined()
    expect(launchEnvFor(p.backend, p.configDir)).toEqual({})
    expect(describeDecision(p, true)).not.toContain('backend')
  })

  it('honours a backend the manifest states even when the transcript is not here yet', async () => {
    // Restoring onto a fresh machine: nothing to infer from, so the manifest's
    // own record is all there is.
    const p = await planFor({
      name: 'gapminder-login',
      dir: repo,
      sessionId: SESSION_ID,
      backend: 'test-account',
    })
    expect(p.backend).toBe('test-account')
    expect(p.sessionId).toBe(SESSION_ID)
  })
})

describe('buildResumeCommand', () => {
  const base: PlannedEntry = {
    entry: { name: 'gapminder-login', dir: '/repo' },
    action: 'attach',
    sessionId: 'c1ae54cf-728b-40e5-a4a1-c34ac017968b',
    dir: '/repo',
  }

  it('cds and resumes by id under the default account', () => {
    expect(buildResumeCommand(base, '--flag')).toBe(
      'cd "/repo" && claude --flag --resume c1ae54cf-728b-40e5-a4a1-c34ac017968b --name "gapminder-login"',
    )
  })

  // The whole point of carrying the origin: without CLAUDE_CONFIG_DIR this line
  // runs fine and quietly opens a NEW conversation, because the id isn't in the
  // default config dir.
  it('exports the config dir for a session from another account', () => {
    const cmd = buildResumeCommand({ ...base, configDir: '/home/x/.claude-gapminder' }, '')
    expect(cmd).toStartWith('cd "/repo" && CLAUDE_CONFIG_DIR="/home/x/.claude-gapminder" claude --resume ')
  })

  it('applies a backend preset env and its model', () => {
    const cmd = buildResumeCommand({ ...base, backend: 'kimi' }, '')
    expect(cmd).toContain('CCTABS_ACTIVE_BACKEND="kimi"')
    expect(cmd).toContain('ANTHROPIC_BASE_URL=')
    expect(cmd).toEndWith('--model "kimi-k2.6:cloud"')
  })

  it('quotes a directory containing spaces', () => {
    const cmd = buildResumeCommand({ ...base, dir: '/Users/x/Remember This' }, '')
    expect(cmd).toStartWith('cd "/Users/x/Remember This" &&')
  })

  it('hands the tab back its own permission mode, after the global flags', () => {
    // Verified against a live session: --permission-mode composes with
    // --allow-dangerously-skip-permissions (which only makes bypass available
    // rather than selecting it) and wins, so a plan-mode tab comes back in plan
    // mode under the usual config.
    const cmd = buildResumeCommand(
      { ...base, permissionMode: 'plan' },
      '--allow-dangerously-skip-permissions',
    )
    expect(cmd).toEndWith('--permission-mode plan')
    expect(cmd).toContain('--allow-dangerously-skip-permissions')
  })

  it('omits the flag entirely when no mode was recorded', () => {
    expect(buildResumeCommand(base, '--flag')).not.toContain('--permission-mode')
  })
})
