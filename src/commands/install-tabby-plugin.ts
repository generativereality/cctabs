import { spawn, spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs'
import { homedir, platform } from 'os'
import { join } from 'path'
import { define } from 'gunshi'
import { consola } from 'consola'
import { detectTerminal } from '../core/terminal.js'
import { findLatestSessionId } from '../core/session.js'

function pluginsDir(): string {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'tabby', 'plugins')
  }
  if (platform() === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
    return join(xdg, 'tabby', 'plugins')
  }
  if (platform() === 'win32') {
    const app = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(app, 'tabby', 'plugins')
  }
  throw new Error(`unsupported platform: ${platform()}`)
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export const installTabbyPluginCommand = define({
  name: 'install-tabby-plugin',
  description: 'Install the tabby-cctabs plugin via npm, then quit + reopen Tabby in the background and resume the current claude session in a new tab. Must be run from inside Tabby.',
  args: {
    yes: { type: 'boolean', short: 'y', description: 'Skip the "this will restart Tabby" confirmation' },
    'no-restart': { type: 'boolean', description: 'Install the plugin only; do not quit Tabby. You restart it yourself.' },
  },
  async run(ctx) {
    const yes = Boolean(ctx.values.yes)
    const noRestart = Boolean(ctx.values['no-restart'])

    if (detectTerminal() !== 'tabby') {
      consola.error('cctabs install-tabby-plugin must be run from inside a Tabby tab.')
      consola.info('Open Tabby (`brew install --cask tabby` if you need it) and run this there.')
      process.exit(1)
    }

    if (platform() !== 'darwin' && platform() !== 'linux') {
      consola.error(`Auto-restart isn't implemented for ${platform()} yet. Run the manual install snippet from \`cctabs doctor\` and restart Tabby yourself.`)
      process.exit(1)
    }

    const dir = pluginsDir()
    consola.info(`Tabby plugins dir: ${dir}`)
    mkdirSync(dir, { recursive: true })
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) writeFileSync(pkgPath, '{"private":true}\n')

    consola.info('Installing tabby-cctabs from npm…')
    const npm = spawnSync(
      'npm',
      ['install', '--legacy-peer-deps', '--silent', '--prefix', dir, 'tabby-cctabs'],
      { stdio: 'inherit' },
    )
    if (npm.status !== 0) {
      consola.error('npm install failed. Bail out before touching Tabby.')
      process.exit(npm.status ?? 1)
    }
    consola.success('Plugin installed.')

    if (noRestart) {
      consola.info('Skipping restart (--no-restart). Quit and reopen Tabby manually, then run `cctabs doctor`.')
      return
    }

    // Find current claude session so we can resume it after the restart.
    const cwd = process.cwd()
    const sessionId = findLatestSessionId(cwd)
    if (!sessionId) {
      consola.warn(`No prior Claude session found for ${cwd}. The restart will reopen Tabby with a plain shell tab; you can launch claude yourself.`)
    } else {
      consola.info(`Will resume session ${sessionId.slice(0, 8)}… via --fork-session after restart.`)
    }

    if (!yes) {
      consola.warn('About to quit Tabby and reopen it. ALL Tabby tabs will close.')
      consola.warn("Tabby's session recovery may or may not restore other tabs.")
      consola.info('Re-run with --yes to suppress this prompt.')
      const ok = await consola.prompt('Proceed?', { type: 'confirm', initial: false })
      if (!ok) { consola.info('Aborted.'); return }
    }

    // Locate claude binary
    const claudeWhich = spawnSync('which', ['claude'], { encoding: 'utf-8' })
    const claudeBin = (claudeWhich.stdout || '').trim() || 'claude'

    // Build a detached worker that runs after this process exits.
    const stamp = Date.now()
    const restartScript = join('/tmp', `cctabs-tabby-restart-${stamp}.sh`)
    const launcherScript = join('/tmp', `cctabs-tabby-launcher-${stamp}.sh`)

    const launcherBody = sessionId
      ? `#!/bin/zsh -l
cd ${shellQuote(cwd)} || exit 1
exec ${claudeBin} --resume ${sessionId} --fork-session
`
      : `#!/bin/zsh -l
cd ${shellQuote(cwd)} || exit 1
exec /bin/zsh -l
`
    writeFileSync(launcherScript, launcherBody)
    chmodSync(launcherScript, 0o755)

    const isDarwin = platform() === 'darwin'
    const quitTabby = isDarwin
      ? `osascript -e 'tell application "Tabby" to quit' >/dev/null 2>&1 || true`
      : `pkill -TERM -f Tabby || true`
    const waitForExit = `for i in $(seq 1 30); do pgrep -f "Tabby" >/dev/null || break; sleep 0.5; done`
    const reopenTabby = isDarwin
      ? `open -a Tabby`
      : `nohup tabby >/dev/null 2>&1 &`
    const activate = isDarwin
      ? `osascript -e 'tell application "Tabby" to activate' >/dev/null 2>&1 || true`
      : `:`
    const tabbyCli = isDarwin
      ? `/Applications/Tabby.app/Contents/MacOS/Tabby`
      : `tabby`

    const restartBody = `#!/usr/bin/env bash
set -e
exec >/tmp/cctabs-tabby-restart-${stamp}.log 2>&1
echo "[$(date)] sleeping 2s before quitting Tabby"
sleep 2
echo "[$(date)] quitting Tabby"
${quitTabby}
echo "[$(date)] waiting for Tabby to exit"
${waitForExit}
echo "[$(date)] reopening Tabby"
${reopenTabby}
sleep 5
echo "[$(date)] activating + launching resume tab"
${activate}
sleep 1
${tabbyCli} run ${shellQuote(launcherScript)}
echo "[$(date)] done"
`
    writeFileSync(restartScript, restartBody)
    chmodSync(restartScript, 0o755)

    // Detach from this process so the restart survives Tabby (and us) dying.
    const child = spawn('/bin/bash', [restartScript], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()

    consola.success('Restart worker dispatched.')
    consola.info(`Logs: /tmp/cctabs-tabby-restart-${stamp}.log`)
    consola.info('Tabby will quit in ~2 seconds. After it reopens, your session resumes via --fork-session in a new tab.')
  },
})
