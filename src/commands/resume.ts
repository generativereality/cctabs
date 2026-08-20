import { resolve } from 'path'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig, applyPrefix } from '../core/config.js'
import { requireAdapter } from '../core/adapter.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByName, pathToProjectSlug, listSessionNames, locateSessionById } from '../core/session.js'
import { resolveBackend, resolveBackendName, backendEnvWithMarker, listBackends } from '../core/backends.js'
import type { SessionOrigin } from '../core/config-dirs.js'
import { shellQuoteArg } from '../core/shell.js'
import { applyTabColor, resolveColorPreference, TAB_COLOR_NAMES } from '../core/colors.js'

function shellQuoteEnv(env: Record<string, string>): string {
  const entries = Object.entries(env)
  if (!entries.length) return ''
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') + ' '
}

function formatAge(mtimeMs: number): string {
  const mins = Math.round((Date.now() - mtimeMs) / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export const resumeCommand = define({
  name: 'resume',
  description: 'Resume a claude session by name — reuses existing tab or creates a new one',
  args: {
    name: { type: 'positional', description: 'Tab / session name' },
    dir: { type: 'positional', description: 'Working directory (default: cwd)' },
    session: { type: 'string', short: 's', description: 'Session ID to resume (use when multiple sessions share the same name)' },
    backend: { type: 'string', short: 'b', description: 'Backend preset (e.g. kimi, qwen-cloud, qwen-next-local). Defaults to the backend whose Claude config dir the session was found in, else the CURRENT session\'s backend (via CCTABS_ACTIVE_BACKEND) — pass -b anthropic to force the default back explicitly. Run `cctabs backends` to list.' },
    model: { type: 'string', short: 'm', description: 'Override the model name (passed as --model to claude).' },
    color: { type: 'string', short: 'c', description: `Tab colour: ${TAB_COLOR_NAMES.join(', ')} or a hex value like "#0275d8". Applied whether the tab is reused or created. Defaults to the backend preset's \`color\`, else \`[defaults] color\`.` },
  },
  async run(ctx) {
    const name = ctx.positionals[1]
    const dir = resolve((ctx.positionals[2] ?? process.cwd()).replace(/^~/, homedir()))
    if (!name) { consola.error('Tab name is required'); process.exit(1) }

    // On a prefixed install everything this machine minted is "<prefix><name>",
    // so resume resolves the tab, looks up the session, and re-launches
    // `--name` all in prefixed-name space. Empty prefix → displayName === name,
    // i.e. unchanged behaviour.
    const config = loadConfig()
    const displayName = applyPrefix(name, config.defaults.prefix)

    const explicitSession = ctx.values.session as string | undefined
    const explicitBackend = ctx.values.backend as string | undefined
    const modelOverride = ctx.values.model as string | undefined

    let sessionId: string | undefined
    // Where the session turned out to live. A session in a backend's own
    // CLAUDE_CONFIG_DIR must be resumed under that backend, so discovery — not
    // the ambient CCTABS_ACTIVE_BACKEND of whatever tab you happen to be in —
    // is the better default when the user didn't name one.
    let foundOrigin: SessionOrigin = {}

    if (explicitSession) {
      const located =
        locateSessionById(explicitSession, dir) ?? locateSessionById(explicitSession)
      if (!located) {
        consola.error(`Session '${explicitSession}' not found (or matches multiple sessions). Pass the full UUID.`)
        process.exit(1)
      }
      sessionId = located.id
      foundOrigin = { backend: located.backend, configDir: located.configDir }
    } else {
      const sessions = findSessionsByName(dir, displayName)
      if (sessions.length === 0) {
        consola.error(`No session named "${displayName}" in ${dir}`)
        const available = listSessionNames(dir)
        if (available.length) {
          consola.info('Available session names:')
          for (const s of available.slice(0, 15)) {
            consola.log(`  ${s.name}  (${s.id.slice(0, 8)}…)${s.backend ? `  [backend: ${s.backend}]` : ''}`)
          }
        } else {
          consola.info(`Looked in ${pathToProjectSlug(dir)}/ under every known Claude config dir.`)
        }
        process.exit(1)
      } else if (sessions.length === 1) {
        sessionId = sessions[0].id
        foundOrigin = { backend: sessions[0].backend, configDir: sessions[0].configDir }
      } else {
        consola.error(`Multiple "${displayName}" sessions found. Use --session <id> to pick one:\n`)
        for (const s of sessions) {
          consola.log(`  ${s.id}  ${formatAge(s.mtime)}  ${formatSize(s.size)}${s.backend ? `  [backend: ${s.backend}]` : ''}`)
          if (s.firstPrompt) consola.log(`    start: "${s.firstPrompt}"`)
          if (s.lastActivity) consola.log(`    last:  "${s.lastActivity}"`)
        }
        process.exit(1)
      }
    }

    // Backend precedence: what the user asked for, else what the session's own
    // config dir implies, else the backend of the tab we were invoked from.
    const backendName = explicitBackend || foundOrigin.backend || resolveBackendName(undefined)
    let envVars: Record<string, string> | undefined
    let resolvedModel = modelOverride
    let backendColor: string | undefined
    if (backendName) {
      const backend = resolveBackend(backendName)
      if (!backend) {
        consola.error(`Unknown backend "${backendName}". Available:`)
        for (const b of listBackends()) consola.log(`  ${b.name.padEnd(22)} ${b.description}`)
        process.exit(1)
      }
      envVars = backendEnvWithMarker(backendName, backend)
      if (foundOrigin.configDir && !envVars.CLAUDE_CONFIG_DIR) {
        envVars.CLAUDE_CONFIG_DIR = foundOrigin.configDir
      }
      resolvedModel ??= backend.model || undefined
      backendColor = backend.color
    } else if (foundOrigin.configDir) {
      // A config dir nothing has a preset for: pass it through directly, so the
      // resume at least looks for the session where it actually lives.
      envVars = { CLAUDE_CONFIG_DIR: foundOrigin.configDir }
    }
    let color: string | null | undefined
    try {
      color = resolveColorPreference(ctx.values.color as string | undefined, backendColor, config.defaults.color)
    } catch (e) {
      consola.error((e as Error).message)
      process.exit(1)
    }

    const inferredBackend = !explicitBackend && !!foundOrigin.backend
    const inheritedBackend = !explicitBackend && !inferredBackend && !!backendName
    const be = backendName
      ? ` [backend: ${backendName}${inferredBackend ? ' (from session)' : inheritedBackend ? ' (inherited)' : ''}]`
      : ''

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    // Exact-name only. The prefix fallback is for hand-typed lookups; here the
    // question is "does THIS session's tab already exist?", and a longer-named
    // neighbour (`gapminder-login` for `gapminder`) answering yes makes resume
    // refuse with "already running" for a tab that isn't even open.
    const matchingTabs = adapter.resolveTab(displayName, tabsById, tabNames, { exact: true })

    if (matchingTabs.length > 1) {
      consola.error(`Multiple tabs match '${displayName}':`)
      for (const tid of matchingTabs) {
        consola.error(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      }
      process.exit(1)
    }

    if (matchingTabs.length === 1) {
      // Reuse existing tab
      if (!sessionId) {
        consola.error(`Tab "${displayName}" exists but no Claude session found to resume in ${dir}`)
        process.exit(1)
      }
      const tabId = matchingTabs[0]
      const blocks = tabsById.get(tabId) ?? []
      const termBlock = blocks.find((b) => b.view === 'term')
      if (!termBlock) {
        consola.error(`No terminal block found in tab '${displayName}'`)
        process.exit(1)
      }

      // The "is Claude running" guard exists to protect OTHER tabs — we don't
      // want to spray `claude --resume…` into a tab where Claude is at its
      // prompt. But for the current tab the guard misfires: the user is
      // literally at a shell prompt (they just ran cctabs), and the detector
      // is reading stale Claude UI out of scrollback. Skip the guard when
      // we're invoked from a real shell in the target tab. Still honor it
      // when cctabs is invoked from inside Claude itself (CLAUDECODE=1) —
      // there sendInput would go to Claude's UI, not a shell.
      const isCurrentTab = tabId === adapter.currentTabId()
      const insideClaude = !!process.env.CLAUDECODE
      const status = adapter.detectSessionStatus(termBlock.blockid)
      if ((status === 'active' || status === 'idle') && !(isCurrentTab && !insideClaude)) {
        adapter.closeSocket()
        consola.warn(`Claude is already running in tab "${displayName}" (${status}) — skipping resume`)
        process.exit(0)
      }

      // Nothing captured for this tab. That is typical after a terminal restart
      // — no shell, so recreate rather than send into the void — but it also
      // happens to a perfectly live tab whose output the backend never captured.
      // The pid tells the two apart; without one we'd be closing a running
      // Claude to "restore" the session already inside it.
      if (status === 'unreadable') {
        if (termBlock.pid) {
          adapter.closeSocket()
          consola.warn(
            `Tab "${displayName}" has no captured output but pid ${termBlock.pid} is running — refusing to recreate it. Open the tab to see what's in it.`,
          )
          process.exit(0)
        }
        const stillEmpty = await adapter.confirmScrollbackEmpty(termBlock.blockid)
        if (stillEmpty) {
          consola.info(`Tab "${displayName}" has no live shell (no process, no output) — recreating`)
          for (const b of blocks) adapter.deleteBlock(b.blockid)
          adapter.closeSocket()
          const newTabId = await openSession({
            tabName: displayName,
            dir,
            claudeCmd: `claude --resume ${sessionId} --name ${JSON.stringify(displayName)}`,
            envVars,
            modelOverride: resolvedModel,
            afterActive: true,
            color,
          })
          consola.success(`Tab "${displayName}" [${newTabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir} (recreated)${be}`)
          return
        }
      }

      // Resuming into an existing tab is the case a create-time-only colour
      // would miss — the tab is already there, so colour it in place.
      if (color !== undefined) await applyTabColor(adapter, tabId, color)

      const extraFlags = config.claude.flags.map(shellQuoteArg).join(' ')
      const envPrefix = envVars ? shellQuoteEnv(envVars) : ''
      const modelPart = resolvedModel ? ` --model ${JSON.stringify(resolvedModel)}` : ''
      const cmd = `cd ${JSON.stringify(dir)} && ${envPrefix}claude${extraFlags ? ' ' + extraFlags : ''} --resume ${sessionId} --name ${JSON.stringify(displayName)}${modelPart}\r`
      await adapter.sendInput(termBlock.blockid, cmd)

      // For the current tab the verification poll can't work: the resume
      // command sits in the pty buffer until cctabs exits and the shell takes
      // over, which happens *after* this function returns. Just queue it.
      if (isCurrentTab) {
        adapter.closeSocket()
        consola.success(`Tab "${displayName}" [${tabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir} (queued in this shell)${be}`)
        return
      }

      // Verify Claude actually started (poll for up to 15s)
      let verified = false
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500))
        const newStatus = adapter.detectSessionStatus(termBlock.blockid)
        if (newStatus === 'active' || newStatus === 'idle') {
          verified = true
          break
        }
      }

      adapter.closeSocket()
      if (verified) {
        consola.success(`Tab "${displayName}" [${tabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir}${be}`)
      } else {
        consola.warn(`Tab "${displayName}" [${tabId.slice(0, 8)}] — command sent but Claude may not have started (scrollback check inconclusive)`)
      }
    } else if (sessionId) {
      // No existing tab but session found — create a new tab and resume
      adapter.closeSocket()
      const tabId = await openSession({
        tabName: displayName,
        dir,
        claudeCmd: `claude --resume ${sessionId} --name ${JSON.stringify(displayName)}`,
        envVars,
        modelOverride: resolvedModel,
        afterActive: true,
        color,
      })
      consola.success(`Tab "${displayName}" [${tabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir} (new tab)${be}`)
    } else {
      // No existing tab and no session — create a new tab with a fresh claude session
      adapter.closeSocket()
      const tabId = await openSession({
        tabName: displayName,
        dir,
        claudeCmd: 'claude',
        envVars,
        modelOverride: resolvedModel,
        color,
      })
      consola.success(`Tab "${displayName}" [${tabId.slice(0, 8)}] → claude at ${dir} (new tab, no prior session found)${be}`)
    }
  },
})
