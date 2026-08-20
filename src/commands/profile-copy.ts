import { define } from 'gunshi'
import { consola } from 'consola'
import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { requireAdapter } from '../core/adapter.js'
import { loadConfig, applyPrefix } from '../core/config.js'
import { DEFAULT_CONFIG_ROOT, listClaudeConfigDirs } from '../core/config-dirs.js'
import type { ClaudeConfigDir } from '../core/config-dirs.js'
import { listBackends, resolveBackend, launchEnvFor } from '../core/backends.js'
import {
  findSessionFileById,
  locateSessionById,
  persistSessionTitle,
  resolveTabSession,
} from '../core/session.js'
import {
  archiveProjectDir,
  executeSessionCopy,
  planSessionCopy,
  projectDirHasTranscripts,
  removeSourceSession,
} from '../core/session-copy.js'
import { waitForTabExit } from '../core/tab-exit.js'
import { openSession } from '../core/open-session.js'
import { repoRootOf } from '../core/worktree.js'

function expandTilde(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()))
}

function timestampSlug(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** A single config dir, as the scope argument discovery functions want. */
function scopeFor(root: string): ClaudeConfigDir[] {
  return [{ root, projectsRoot: join(root, 'projects') }]
}

interface TargetProfile {
  /** Preset name, when `--to` named one. */
  backend?: string
  configRoot: string
}

/**
 * Resolve `--to` to a Claude config dir.
 *
 * A backend preset is the primary spelling, and not for tidiness: on macOS the
 * Keychain holds ONE Claude Code login per OS user and it isn't scoped by
 * CLAUDE_CONFIG_DIR, so running a session under another profile depends on that
 * profile's `CLAUDE_CODE_OAUTH_TOKEN`. Presets already carry it. A bare path is
 * accepted for the case where no preset exists yet, with a warning, because it
 * will find the transcript but may not be able to authenticate.
 */
function resolveTargetProfile(to: string): TargetProfile | { error: string } {
  if (to.startsWith('/') || to.startsWith('~')) {
    const configRoot = expandTilde(to)
    consola.warn(
      `--to ${to} is a bare config dir, so no OAuth token comes with it. If Claude can't authenticate there, define a [backends.<name>] preset with env_CLAUDE_CODE_OAUTH_TOKEN and env_CLAUDE_CONFIG_DIR and pass that instead.`,
    )
    return { configRoot }
  }

  const spec = resolveBackend(to)
  if (!spec) {
    return { error: `Unknown backend preset "${to}". Run \`cctabs backends\` to list, or pass a config dir path.` }
  }
  const configRoot = spec.env.CLAUDE_CONFIG_DIR
  if (!configRoot) {
    return {
      error: `Backend preset "${to}" doesn't set env_CLAUDE_CONFIG_DIR, so it isn't a separate Claude profile — its sessions live in the default ~/.claude alongside everything else. Nothing to copy into.`,
    }
  }
  return { backend: to, configRoot: expandTilde(configRoot) }
}

export const profileCopyCommand = define({
  name: 'profile-copy',
  description: 'Copy (or move) a Claude session into another Claude profile / account and open it in a new tab',
  args: {
    target: { type: 'positional', description: 'Source tab name, or a session ID' },
    to: { type: 'string', short: 't', description: 'Target backend preset (one that sets env_CLAUDE_CONFIG_DIR), or a config dir path. Run `cctabs backends` to list.' },
    name: { type: 'string', short: 'n', description: 'Name for the new tab / session (default: <source>-<preset>)' },
    move: { type: 'boolean', description: 'Remove the session from the source profile afterwards. Refuses while the source is still running unless --close-source.' },
    'close-source': { type: 'boolean', description: 'Close the source tab first and wait for its process to actually exit, then move.' },
    force: { type: 'boolean', short: 'f', description: 'Overwrite an existing session file in the target profile' },
    'no-open': { type: 'boolean', description: 'Copy the files but do not open a tab' },
    dry: { type: 'boolean', description: 'Report what would happen without copying, removing or opening anything' },
  },
  async run(ctx) {
    const query = ctx.positionals[1] as string | undefined
    const to = ctx.values.to as string | undefined
    const explicitName = ctx.values.name as string | undefined
    const doMove = (ctx.values.move as boolean | undefined) ?? false
    const closeSource = (ctx.values['close-source'] as boolean | undefined) ?? false
    const force = (ctx.values.force as boolean | undefined) ?? false
    const noOpen = (ctx.values['no-open'] as boolean | undefined) ?? false
    const dry = (ctx.values.dry as boolean | undefined) ?? false

    if (!query) { consola.error('A source tab name or session ID is required.'); process.exit(1) }
    if (!to) {
      consola.error('--to <preset|config-dir> is required. Presets that set env_CLAUDE_CONFIG_DIR:')
      for (const b of listBackends()) {
        const spec = resolveBackend(b.name)
        if (spec?.env.CLAUDE_CONFIG_DIR) consola.log(`  ${b.name.padEnd(22)} ${spec.env.CLAUDE_CONFIG_DIR}`)
      }
      process.exit(1)
    }
    if (closeSource && !doMove) {
      consola.error('--close-source only makes sense with --move. A copy leaves the source running on purpose.')
      process.exit(1)
    }

    const resolvedTarget = resolveTargetProfile(to)
    if ('error' in resolvedTarget) {
      consola.error(resolvedTarget.error)
      process.exit(1)
    }
    const target = resolvedTarget

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()

    // --- resolve the source session -------------------------------------
    // A tab name is the common spelling; a session id is the escape hatch for a
    // session whose tab is already gone.
    let sessionId: string | undefined
    let sourceName: string | undefined
    let sourceConfigRoot = DEFAULT_CONFIG_ROOT
    let lookupDirs: string[] = []
    let sourceTabId: string | undefined
    let sourcePid: number | undefined
    let sourceBlockId: string | undefined

    const tabMatches = adapter.resolveTab(query, tabsById, tabNames)
    if (tabMatches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of tabMatches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }
    if (tabMatches.length === 1) {
      sourceTabId = tabMatches[0]
      sourceName = tabNames.get(sourceTabId) ?? sourceTabId.slice(0, 8)
      const term = (tabsById.get(sourceTabId) ?? []).find((b) => b.view === 'term')
      const cwd = term?.meta?.['cmd:cwd'] ?? ''
      sourcePid = term?.pid
      sourceBlockId = term?.blockid
      if (!cwd) { consola.error(`Tab "${sourceName}" has no recorded cwd, so its session can't be located.`); process.exit(1) }
      const resolved = resolveTabSession(cwd, sourceName)
      if (!resolved) {
        consola.error(`No Claude session named "${sourceName}" found for ${cwd} in any config dir.`)
        process.exit(1)
      }
      sessionId = resolved.id
      sourceConfigRoot = resolved.configDir ?? DEFAULT_CONFIG_ROOT
      lookupDirs = [resolved.dir, cwd]
    } else {
      const located = locateSessionById(query)
      if (!located) {
        consola.error(`'${query}' matches no open tab and no session ID. Pass a tab name, or the full session UUID.`)
        process.exit(1)
      }
      sessionId = located.id
      sourceConfigRoot = located.configDir ?? DEFAULT_CONFIG_ROOT
      sourceName = undefined
      lookupDirs = []
    }

    if (sourceConfigRoot === target.configRoot) {
      consola.error(`Session ${sessionId.slice(0, 8)}… already lives in ${target.configRoot} — nothing to copy.`)
      process.exit(1)
    }

    // Locate the transcript, scoped to the profile it was found in so a copy
    // that already exists in the target can't be mistaken for the original.
    let sourceJsonl = findSessionFileById(sessionId, lookupDirs, scopeFor(sourceConfigRoot))
    if (!sourceJsonl) {
      // No usable lookup dirs (session-id path), or the slug guess missed:
      // fall back to a scan of the source profile's project dirs.
      const scanned = listClaudeConfigDirs().find((c) => c.root === sourceConfigRoot)
      const projectsRoot = scanned?.projectsRoot ?? join(sourceConfigRoot, 'projects')
      try {
        for (const slug of readdirSync(projectsRoot)) {
          const candidate = join(projectsRoot, slug, `${sessionId}.jsonl`)
          if (existsSync(candidate)) { sourceJsonl = candidate; break }
        }
      } catch { /* no projects dir in that profile */ }
    }
    if (!sourceJsonl) {
      consola.error(`Could not find ${sessionId}.jsonl anywhere under ${join(sourceConfigRoot, 'projects')}.`)
      process.exit(1)
    }

    // --- plan -----------------------------------------------------------
    const plan = planSessionCopy({
      sessionId,
      sourceJsonl,
      targetProjectsRoot: join(target.configRoot, 'projects'),
      fallbackCwd: lookupDirs[0] ? repoRootOf(lookupDirs[0]) : undefined,
    })
    if (!plan) {
      consola.error(
        `No directory recorded in ${sourceJsonl} still exists, and no repo root could be derived — so there's nowhere to file the copy that \`claude --resume\` could find it from. Pass the session through \`cctabs export\`/\`import\` instead, or recreate the directory.`,
      )
      process.exit(1)
    }

    const config = loadConfig()
    const baseName = sourceName ?? sessionId.slice(0, 8)
    // The source usually keeps running, so the copy needs a distinct name or
    // prefix matching becomes ambiguous between the two.
    const newName = applyPrefix(explicitName ?? `${baseName}-${target.backend ?? 'copy'}`, config.defaults.prefix)

    const nameClash = adapter.resolveTab(newName, tabsById, tabNames, { exact: true })
    if (nameClash.length && !explicitName) {
      consola.warn(`A tab named "${newName}" already exists — pass --name to pick another, or it will be ambiguous to resume by name.`)
    }

    consola.info(`Session ${sessionId.slice(0, 8)}…  ${sourceName ? `"${sourceName}"` : ''}`)
    consola.log(`  from: ${sourceConfigRoot}`)
    consola.log(`  to:   ${target.configRoot}${target.backend ? `  [preset: ${target.backend}]` : ''}`)
    consola.log(`  file: ${plan.sourceJsonl}`)
    consola.log(`     →  ${plan.targetJsonl}`)
    if (plan.sidecarFileCount) {
      consola.log(`  sidecar: ${plan.sidecarFileCount} file${plan.sidecarFileCount === 1 ? '' : 's'} (subagents / tool results)`)
    } else {
      consola.log('  sidecar: none')
    }
    if (plan.target.reason === 'repo-root') {
      consola.warn(
        `The session's recorded directory no longer exists, so the copy is filed under the repo root (${plan.target.dir}) instead. Filed under the original slug, \`claude --resume\` would fail with "No conversation found with session ID" even though the transcript is right there.`,
      )
    } else if (plan.target.reason === 'fallback') {
      consola.warn(`No usable cwd in the transcript — filing the copy under ${plan.target.dir}.`)
    }
    consola.log(`  new tab name: ${newName}`)

    // --- liveness / move safety ------------------------------------------
    // A `mv` inside one filesystem is a rename: the inode is unchanged, so a
    // running claude's open descriptor follows the file. The old tab and the new
    // one then append to the SAME transcript and interleave two conversations
    // into one unusable file. So a move is only ever safe against a dead source.
    const sourceAlive = !!sourcePid || (sourceBlockId
      ? ['active', 'idle'].includes(adapter.detectSessionStatus(sourceBlockId))
      : false)

    if (doMove && sourceAlive && !closeSource) {
      adapter.closeSocket()
      consola.error(
        `Refusing to --move: the source tab is still running (${sourcePid ? `pid ${sourcePid}` : 'session detected'}).`,
      )
      consola.info('A move is a rename, so the running claude keeps writing to the moved file and both tabs interleave into one transcript.')
      consola.info(`Either drop --move (a copy diverges cleanly, like --fork-session), or pass --close-source to close "${sourceName}" and wait for it to exit first.`)
      process.exit(1)
    }

    if (dry) {
      adapter.closeSocket()
      consola.log('')
      consola.info(`dry run — nothing copied. Would ${doMove ? 'move' : 'copy'}${noOpen ? '' : ' and open a tab'}.`)
      if (doMove && sourceAlive) consola.info(`Would close "${sourceName}" and wait for its process to exit before removing the source.`)
      return
    }

    // --- copy ------------------------------------------------------------
    let sidecarFilesCopied = 0
    try {
      ;({ sidecarFilesCopied } = executeSessionCopy(plan, { overwrite: force }))
    } catch (e) {
      adapter.closeSocket()
      consola.error((e as Error).message)
      process.exit(1)
    }
    consola.success(`Copied transcript${sidecarFilesCopied ? ` + ${sidecarFilesCopied} sidecar file${sidecarFilesCopied === 1 ? '' : 's'}` : ''} → ${plan.targetJsonl}`)

    // Name the copy on disk so `cctabs resume <newName>` finds it. Appended to
    // the copy only — the source keeps its own name.
    try {
      persistSessionTitle(plan.targetJsonl, sessionId, newName)
    } catch (e) {
      consola.warn(`Copied, but could not write the new title into the transcript: ${(e as Error).message}`)
      consola.warn(`\`cctabs resume ${newName}\` won't find it until the session is renamed.`)
    }

    // --- move: close, wait for real exit, remove, sweep ------------------
    if (doMove) {
      if (sourceAlive && closeSource && sourceTabId) {
        consola.info(`Closing "${sourceName}" and waiting for its process to exit…`)
        for (const b of tabsById.get(sourceTabId) ?? []) adapter.deleteBlock(b.blockid)
        const exit = await waitForTabExit(adapter, sourceTabId, sourcePid)
        if (!exit.processGone) {
          adapter.closeSocket()
          consola.error(
            `The source process did not exit in time (tab gone: ${exit.tabGone}). The copy is in place at ${plan.targetJsonl}; the source was left untouched deliberately — removing it now could race the still-running process. Re-run with --move once it has exited.`,
          )
          process.exit(1)
        }
        consola.success('Source process exited.')
      }

      const removal = removeSourceSession(plan.sourceJsonl, sessionId)
      if (removal.removedJsonl) consola.success(`Removed source transcript ${plan.sourceJsonl}`)
      if (removal.removedSidecar) consola.log('  removed its sidecar directory too')
      if (removal.sweptStub) {
        consola.success('Swept the metadata trailer the closing process wrote back to the old path.')
        consola.log('  Left in place it would have shadowed the moved session on the next `restore`, since resolution matches the customTitle inside the file.')
      }

      // A worktree-named project dir left behind is treated as proof the
      // worktree still exists, which sends a later restore into a deleted path.
      // Renaming it in place doesn't help — matching is on the customTitle
      // inside the transcripts — so it has to leave `projects/` entirely.
      // Only when the directory that slug names is genuinely gone — which is
      // exactly the case that forced the copy to be relocated to the repo root.
      // A slug whose directory still exists is a live project dir and must stay.
      const sourceProjectDir = join(plan.sourceJsonl, '..')
      if (plan.target.reason === 'repo-root' && !projectDirHasTranscripts(sourceProjectDir)) {
        const archived = archiveProjectDir(sourceProjectDir, sourceConfigRoot, timestampSlug())
        if (archived) {
          consola.success(`Archived the now-empty source project dir → ${archived}`)
          consola.log('  Moved out of projects/ rather than renamed in place, so it can no longer shadow the session: resolution matches the customTitle inside the transcripts, not the directory name.')
        }
      }
    }

    // --- open the tab under the target account --------------------------
    if (noOpen) {
      adapter.closeSocket()
      consola.info(`--no-open: resume it yourself with  cctabs resume ${newName} ${plan.target.dir}`)
      return
    }

    const { env, model } = launchEnvFor(target.backend, target.configRoot)
    adapter.closeSocket()
    const newTabId = await openSession({
      tabName: newName,
      dir: plan.target.dir,
      claudeCmd: `claude --resume ${sessionId} --name ${JSON.stringify(newName)}`,
      envVars: env,
      modelOverride: model,
      afterActive: true,
    })
    consola.success(
      `Tab "${newName}" [${newTabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${plan.target.dir}${target.backend ? ` [backend: ${target.backend}]` : ''}`,
    )
  },
})
