import { define } from 'gunshi'
import { consola } from 'consola'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir, hostname } from 'os'
import { execFileSync } from 'child_process'
import { requireAdapter } from '../core/adapter.js'
import { findSessionsByName, pathToProjectSlug } from '../core/session.js'
import pkg from '../../package.json'

interface ExportedTab {
  name: string
  cwd: string
  sessionId: string
  claudeProjectSlug: string
  workspace?: string
}

interface ExportMeta {
  cctabsExportVersion: 1
  cctabsVersion: string
  exportedAt: string
  sourceMachine: string
  tabs: ExportedTab[]
}

/** Replace anything that isn't safe in a filesystem dir name. */
function safeDirName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'tab'
}

function timestampSlug(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export const exportCommand = define({
  name: 'export',
  description: 'Export tabs + their Claude sessions to a tarball you can move to another machine (then `cctabs import`).',
  args: {
    all: { type: 'boolean', short: 'a', description: 'Export every tab in the workspace (use --workspace to pick one; default is the current workspace).' },
    workspace: { type: 'string', short: 'w', description: 'Workspace to export from when using --all (defaults to current).' },
    out: { type: 'string', short: 'o', description: 'Output path for the tarball. Default: ./cctabs-export-<name>-<timestamp>.tar.gz' },
  },
  async run(ctx) {
    const tabQuery = ctx.positionals[1] as string | undefined
    const exportAll = (ctx.values.all as boolean | undefined) ?? false
    const workspaceQuery = ctx.values.workspace as string | undefined
    const outPath = ctx.values.out as string | undefined

    if (!tabQuery && !exportAll) {
      consola.error('Provide a tab name, or pass --all to export every tab in the workspace.')
      process.exit(1)
    }
    if (tabQuery && exportAll) {
      consola.error('Pass either a tab name OR --all, not both.')
      process.exit(1)
    }

    const adapter = requireAdapter()
    const { tabsById, tabNames, workspaces } = await adapter.getAllData()
    const currentWs = adapter.currentWorkspaceId()

    // Pick the workspace
    let wsData
    if (workspaceQuery) {
      const matches = adapter.resolveWorkspace(workspaces, workspaceQuery)
      if (matches.length === 0) { consola.error(`Workspace not found: ${workspaceQuery}`); process.exit(1) }
      if (matches.length > 1) { consola.error(`Workspace query is ambiguous: ${workspaceQuery}`); process.exit(1) }
      wsData = matches[0].data
    } else {
      wsData = workspaces.find((w) => w.workspacedata.oid === currentWs)?.workspacedata
    }
    if (!wsData) {
      consola.error('Could not determine workspace.')
      process.exit(1)
    }
    const wsName = wsData.name
    const wsTabIds = wsData.tabids.filter((t) => tabsById.has(t))

    // Build the list of tabs to export
    let targetTabIds: string[]
    if (exportAll) {
      targetTabIds = wsTabIds
    } else {
      const matched = adapter.resolveTab(tabQuery!, tabsById, tabNames).filter((tid) => wsTabIds.includes(tid))
      if (matched.length === 0) { consola.error(`No tab in workspace "${wsName}" matches: ${tabQuery}`); process.exit(1) }
      if (matched.length > 1) { consola.error(`Tab query is ambiguous: ${tabQuery} (matches ${matched.length} tabs)`); process.exit(1) }
      targetTabIds = matched
    }

    // Stage in a temp dir, then tar it up.
    const stageRoot = mkdtempSync(join(tmpdir(), 'cctabs-export-'))
    const tabsRoot = join(stageRoot, 'tabs')
    mkdirSync(tabsRoot, { recursive: true })

    const exported: ExportedTab[] = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const tabId of targetTabIds) {
      const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
      const termBlock = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')
      if (!termBlock) { skipped.push({ name: tabName, reason: 'no terminal block' }); continue }
      const cwd = termBlock.meta?.['cmd:cwd']
      if (!cwd) { skipped.push({ name: tabName, reason: 'no cwd recorded' }); continue }

      // Resolve session id by tab name. First try the tab's recorded cwd; if the
      // session lives in a worktree (`<cwd>/.claude/worktrees/<name>/`) the
      // Claude project slug is different, so fall back to scanning worktrees.
      let sessionId: string | undefined
      let effectiveCwd = cwd
      try {
        const matches = findSessionsByName(cwd, tabName)
        if (matches.length) sessionId = matches[0].id
      } catch { /* best-effort */ }
      if (!sessionId) {
        const worktreesDir = join(cwd, '.claude', 'worktrees')
        if (existsSync(worktreesDir)) {
          try {
            const candidates: Array<{ id: string; mtime: number; path: string }> = []
            for (const entry of readdirSync(worktreesDir)) {
              const wtPath = join(worktreesDir, entry)
              if (!statSync(wtPath).isDirectory()) continue
              try {
                const matches = findSessionsByName(wtPath, tabName)
                if (matches.length) candidates.push({ id: matches[0].id, mtime: matches[0].mtime, path: wtPath })
              } catch { /* keep scanning */ }
            }
            if (candidates.length) {
              candidates.sort((a, b) => b.mtime - a.mtime)
              sessionId = candidates[0].id
              effectiveCwd = candidates[0].path
            }
          } catch { /* worktrees dir unreadable */ }
        }
      }
      if (!sessionId) { skipped.push({ name: tabName, reason: 'no Claude session found for this tab name + cwd' }); continue }

      const slug = pathToProjectSlug(effectiveCwd)
      const jsonlPath = join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`)
      if (!existsSync(jsonlPath)) { skipped.push({ name: tabName, reason: `session file missing: ${jsonlPath}` }); continue }

      const tabDir = join(tabsRoot, safeDirName(tabName))
      mkdirSync(tabDir, { recursive: true })
      copyFileSync(jsonlPath, join(tabDir, 'session.jsonl'))
      const manifest = { name: tabName, cwd: effectiveCwd, sessionId, claudeProjectSlug: slug, workspace: wsName }
      writeFileSync(join(tabDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

      exported.push({ ...manifest })
    }

    if (exported.length === 0) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error('Nothing to export. Skipped tabs:')
      for (const s of skipped) consola.log(`  ${s.name}: ${s.reason}`)
      process.exit(1)
    }

    const meta: ExportMeta = {
      cctabsExportVersion: 1,
      cctabsVersion: pkg.version,
      exportedAt: new Date().toISOString(),
      sourceMachine: hostname(),
      tabs: exported,
    }
    writeFileSync(join(stageRoot, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

    const defaultName = exportAll
      ? `cctabs-export-${safeDirName(wsName)}-${timestampSlug()}.tar.gz`
      : `cctabs-export-${safeDirName(exported[0].name)}-${timestampSlug()}.tar.gz`
    const resolvedOut = outPath ?? join(process.cwd(), defaultName)

    try {
      execFileSync('tar', ['-czf', resolvedOut, '-C', stageRoot, '.'], { stdio: 'inherit' })
    } catch (err) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error(`tar failed: ${(err as Error).message}`)
      process.exit(1)
    }

    rmSync(stageRoot, { recursive: true, force: true })

    consola.success(`Exported ${exported.length} tab${exported.length === 1 ? '' : 's'} → ${resolvedOut}`)
    for (const t of exported) consola.log(`  ✓ ${t.name}  (${t.sessionId.slice(0, 8)}…)  ${t.cwd}`)
    if (skipped.length) {
      consola.warn(`Skipped ${skipped.length}:`)
      for (const s of skipped) consola.log(`  - ${s.name}: ${s.reason}`)
    }
    consola.log('')
    consola.log(`Import on another machine with:  cctabs import ${defaultName}`)
  },
})
