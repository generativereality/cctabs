import { resolve } from 'path'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireWaveAdapter } from '../core/wave.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByName, pathToProjectSlug, listSessionNames } from '../core/session.js'

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
  },
  async run(ctx) {
    const name = ctx.positionals[1]
    const dir = resolve((ctx.positionals[2] ?? process.cwd()).replace(/^~/, homedir()))
    if (!name) { consola.error('Tab name is required'); process.exit(1) }

    const explicitSession = ctx.values.session as string | undefined
    let sessionId: string | undefined

    if (explicitSession) {
      sessionId = explicitSession
    } else {
      const sessions = findSessionsByName(dir, name)
      if (sessions.length === 0) {
        consola.error(`No session named "${name}" in ${dir}`)
        const available = listSessionNames(dir)
        if (available.length) {
          consola.info('Available session names:')
          for (const s of available.slice(0, 15)) {
            consola.log(`  ${s.name}  (${s.id.slice(0, 8)}…)`)
          }
        } else {
          consola.info(`Looked in ~/.claude/projects/${pathToProjectSlug(dir)}/`)
        }
        process.exit(1)
      } else if (sessions.length === 1) {
        sessionId = sessions[0].id
      } else {
        consola.error(`Multiple "${name}" sessions found. Use --session <id> to pick one:\n`)
        for (const s of sessions) {
          consola.log(`  ${s.id}  ${formatAge(s.mtime)}  ${formatSize(s.size)}`)
          if (s.firstPrompt) consola.log(`    start: "${s.firstPrompt}"`)
          if (s.lastActivity) consola.log(`    last:  "${s.lastActivity}"`)
        }
        process.exit(1)
      }
    }

    const adapter = requireWaveAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matchingTabs = adapter.resolveTab(name, tabsById, tabNames)

    if (matchingTabs.length > 1) {
      consola.error(`Multiple tabs match '${name}':`)
      for (const tid of matchingTabs) {
        consola.error(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      }
      process.exit(1)
    }

    if (matchingTabs.length === 1) {
      // Reuse existing tab
      if (!sessionId) {
        consola.error(`Tab "${name}" exists but no Claude session found to resume in ${dir}`)
        process.exit(1)
      }
      const tabId = matchingTabs[0]
      const blocks = tabsById.get(tabId) ?? []
      const termBlock = blocks.find((b) => b.view === 'term')
      if (!termBlock) {
        consola.error(`No terminal block found in tab '${name}'`)
        process.exit(1)
      }

      // Guard: don't send resume into a tab where Claude is already running
      const status = adapter.detectSessionStatus(termBlock.blockid)
      if (status === 'active' || status === 'idle') {
        adapter.closeSocket()
        consola.warn(`Claude is already running in tab "${name}" (${status}) — skipping resume`)
        process.exit(0)
      }
      if (status === 'unknown') {
        consola.warn(`Scrollback unavailable for tab "${name}" — cannot confirm shell is ready. Proceeding anyway.`)
      }

      const config = loadConfig()
      const extraFlags = config.claude.flags.join(' ')
      const cmd = `cd ${JSON.stringify(dir)} && claude${extraFlags ? ' ' + extraFlags : ''} --resume ${sessionId} --name ${JSON.stringify(name)}\r`
      await adapter.sendInput(termBlock.blockid, cmd)

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
        consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir}`)
      } else {
        consola.warn(`Tab "${name}" [${tabId.slice(0, 8)}] — command sent but Claude may not have started (scrollback check inconclusive)`)
      }
    } else if (sessionId) {
      // No existing tab but session found — create a new tab and resume
      adapter.closeSocket()
      const tabId = await openSession({
        tabName: name,
        dir,
        claudeCmd: `claude --resume ${sessionId} --name ${JSON.stringify(name)}`,
      })
      consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude --resume ${sessionId.slice(0, 8)}… at ${dir} (new tab)`)
    } else {
      // No existing tab and no session — create a new tab with a fresh claude session
      adapter.closeSocket()
      const tabId = await openSession({
        tabName: name,
        dir,
        claudeCmd: 'claude',
      })
      consola.success(`Tab "${name}" [${tabId.slice(0, 8)}] → claude at ${dir} (new tab, no prior session found)`)
    }
  },
})
