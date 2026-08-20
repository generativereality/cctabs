import { define } from 'gunshi'
import { consola } from 'consola'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, rmSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { execFileSync } from 'child_process'
import { loadConfig } from '../core/config.js'
import { openSession } from '../core/open-session.js'
import { pathToProjectSlug } from '../core/session.js'
import { shellQuoteArg } from '../core/shell.js'
import { DEFAULT_CONFIG_ROOT } from '../core/config-dirs.js'
import { launchEnvFor, resolveBackend } from '../core/backends.js'
import { copyDirRecursive, sidecarDirFor } from '../core/session-copy.js'

/** Must match the export's staged sidecar directory name. */
const STAGED_SIDECAR = 'sidecar'

interface ExportedTab {
  name: string
  cwd: string
  sessionId: string
  claudeProjectSlug: string
  workspace?: string
  /** Preset owning the profile this session came from, when not the default. */
  backend?: string
  sidecarFiles?: number
}

interface ExportMeta {
  cctabsExportVersion: number
  cctabsVersion?: string
  exportedAt?: string
  sourceMachine?: string
  tabs: ExportedTab[]
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

export const importCommand = define({
  name: 'import',
  description: 'Import tabs + sessions from a cctabs-export tarball (produced by `cctabs export`) and open each one as a new tab.',
  args: {
    cwd: { type: 'string', short: 'C', description: 'Target working directory. With a single-tab archive, replaces the original cwd. Ignored for multi-tab archives.' },
    workspace: { type: 'string', short: 'w', description: 'Workspace to open the new tab(s) in (defaults to current).' },
    force: { type: 'boolean', short: 'f', description: 'Overwrite an existing session jsonl in the target profile if the same session id already exists locally.' },
    'dry-run': { type: 'boolean', short: 'n', description: 'Report what would happen without copying files or spawning tabs.' },
  },
  async run(ctx) {
    const archive = ctx.positionals[1] as string | undefined
    const cwdOverride = ctx.values.cwd as string | undefined
    const workspaceQuery = ctx.values.workspace as string | undefined
    const force = (ctx.values.force as boolean | undefined) ?? false
    const dryRun = (ctx.values['dry-run'] as boolean | undefined) ?? false

    if (!archive) { consola.error('Archive path is required.'); process.exit(1) }
    const archivePath = resolve(expandHome(archive))
    if (!existsSync(archivePath)) { consola.error(`Archive not found: ${archivePath}`); process.exit(1) }

    // Extract to a scratch dir
    const stageRoot = mkdtempSync(join(tmpdir(), 'cctabs-import-'))
    try {
      execFileSync('tar', ['-xzf', archivePath, '-C', stageRoot], { stdio: 'inherit' })
    } catch (err) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error(`tar failed to extract ${archivePath}: ${(err as Error).message}`)
      process.exit(1)
    }

    const metaPath = join(stageRoot, 'meta.json')
    if (!existsSync(metaPath)) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error('Archive does not contain meta.json — not a cctabs export.')
      process.exit(1)
    }

    let meta: ExportMeta
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as ExportMeta
    } catch (err) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error(`meta.json is malformed: ${(err as Error).message}`)
      process.exit(1)
    }

    if (meta.cctabsExportVersion !== 1) {
      rmSync(stageRoot, { recursive: true, force: true })
      consola.error(`Unsupported cctabsExportVersion: ${meta.cctabsExportVersion} (this build understands version 1).`)
      process.exit(1)
    }

    if (cwdOverride && meta.tabs.length > 1) {
      consola.warn(`--cwd was provided but archive contains ${meta.tabs.length} tabs; --cwd is ignored for multi-tab imports.`)
    }

    consola.info(`Importing ${meta.tabs.length} tab${meta.tabs.length === 1 ? '' : 's'} from ${archivePath}`)
    if (meta.sourceMachine) consola.log(`  Source: ${meta.sourceMachine}${meta.cctabsVersion ? ` (cctabs ${meta.cctabsVersion})` : ''}`)
    if (meta.exportedAt) consola.log(`  Exported: ${meta.exportedAt}`)
    consola.log('')

    // The export staged each tab under tabs/<safe-name>/. Match staged dirs to manifest entries by sessionId.
    const tabsDir = join(stageRoot, 'tabs')
    const stagedDirs = existsSync(tabsDir)
      ? readdirSync(tabsDir).filter((n) => statSync(join(tabsDir, n)).isDirectory())
      : []

    const results: Array<{ name: string; status: string }> = []

    for (const entry of meta.tabs) {
      // Locate the staged tab dir for this entry by reading each manifest.json
      let stagedDir: string | undefined
      for (const d of stagedDirs) {
        const m = join(tabsDir, d, 'manifest.json')
        if (!existsSync(m)) continue
        try {
          const parsed = JSON.parse(readFileSync(m, 'utf-8')) as { sessionId?: string }
          if (parsed.sessionId === entry.sessionId) { stagedDir = join(tabsDir, d); break }
        } catch { /* ignore */ }
      }
      if (!stagedDir) {
        results.push({ name: entry.name, status: `staged tab dir not found for sessionId ${entry.sessionId.slice(0, 8)}…` })
        continue
      }

      const targetCwd = resolve(
        expandHome(meta.tabs.length === 1 && cwdOverride ? cwdOverride : entry.cwd),
      )
      if (!existsSync(targetCwd)) {
        results.push({ name: entry.name, status: `cwd missing on this machine: ${targetCwd} (clone the repo, then re-run)` })
        continue
      }

      // Put the session back under the account it came from when this machine
      // has a preset of that name. Importing a second-account session into the
      // default profile doesn't fail — `claude --resume` just can't find the id
      // there and silently opens a fresh conversation instead.
      let targetConfigRoot = DEFAULT_CONFIG_ROOT
      let targetBackend: string | undefined
      if (entry.backend) {
        const spec = resolveBackend(entry.backend)
        const dir = spec?.env.CLAUDE_CONFIG_DIR
        if (dir) {
          targetConfigRoot = expandHome(dir)
          targetBackend = entry.backend
        } else {
          consola.warn(
            `"${entry.name}" came from backend "${entry.backend}", which isn't defined on this machine — importing into the default profile. Define that preset and re-import if the session belongs to another account.`,
          )
        }
      }

      const targetSlug = pathToProjectSlug(targetCwd)
      const targetProjectDir = join(targetConfigRoot, 'projects', targetSlug)
      const targetJsonl = join(targetProjectDir, `${entry.sessionId}.jsonl`)
      const srcJsonl = join(stagedDir, 'session.jsonl')
      const srcSidecar = join(stagedDir, STAGED_SIDECAR)

      if (existsSync(targetJsonl) && !force) {
        results.push({ name: entry.name, status: `already present at ${targetJsonl} (pass --force to overwrite)` })
        continue
      }

      if (dryRun) {
        const sc = existsSync(srcSidecar) ? ` (+ sidecar)` : ''
        results.push({ name: entry.name, status: `dry-run: would copy → ${targetJsonl}${sc} and open tab in ${targetCwd}` })
        continue
      }

      mkdirSync(targetProjectDir, { recursive: true })
      copyFileSync(srcJsonl, targetJsonl)

      // Restore the sidecar (subagent transcripts, tool results) alongside the
      // transcript. Archives written before sidecars were bundled simply have
      // none, so this is a no-op for them.
      let sidecarRestored = 0
      if (existsSync(srcSidecar) && statSync(srcSidecar).isDirectory()) {
        sidecarRestored = copyDirRecursive(srcSidecar, sidecarDirFor(targetJsonl))
      }

      // Spawn the tab
      const config = loadConfig()
      const extraFlags = config.claude.flags.length ? ' ' + config.claude.flags.map(shellQuoteArg).join(' ') : ''
      const claudeCmd = `claude${extraFlags} --resume ${entry.sessionId} --name ${JSON.stringify(entry.name)}`
      const { env, model } = launchEnvFor(targetBackend, targetBackend ? targetConfigRoot : undefined)
      const bundled = sidecarRestored ? `, +${sidecarRestored} sidecar files` : ''
      try {
        await openSession({
          tabName: entry.name,
          dir: targetCwd,
          claudeCmd,
          workspaceQuery,
          envVars: env,
          modelOverride: model,
        })
        results.push({ name: entry.name, status: `imported → ${targetJsonl}${bundled}, tab opened` })
      } catch (err) {
        results.push({ name: entry.name, status: `jsonl copied${bundled} but failed to open tab: ${(err as Error).message}` })
      }
    }

    rmSync(stageRoot, { recursive: true, force: true })

    consola.log('')
    consola.log('Results:')
    for (const r of results) consola.log(`  ${r.name.padEnd(24)} ${r.status}`)
  },
})
