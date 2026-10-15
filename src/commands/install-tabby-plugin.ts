import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'
import { define } from 'gunshi'
import { consola } from 'consola'
import { detectTerminal } from '../core/terminal.js'
import { requireAdapter } from '../core/adapter.js'
import { saveAndClose, startRestartWorker } from './restart-tabby.js'
import { TABBY_PLUGIN, tabbyPluginsDir as pluginsDir } from '../core/tabby-plugin-dir.js'

export const installTabbyPluginCommand = define({
  name: 'install-tabby-plugin',
  description: 'Install the tabby-cctabs plugin via npm, then restart Tabby the way `cctabs restart-tabby` does: every session saved, Tabby quit and reopened, everything restored. Must be run from inside Tabby.',
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

    // Only the AUTO-RESTART half is POSIX-specific (osascript / pkill + a
    // /bin/zsh launcher script). The install itself is `npm --prefix
    // <pluginsDir()>`, which works anywhere - and pluginsDir() has known the
    // Windows path all along. Refusing the whole command left Windows users in
    // a loop: this said "run the manual snippet from `cctabs doctor`", and
    // doctor said "run `cctabs install-tabby-plugin`" and then printed a macOS
    // path. So on an unsupported platform, install and skip the restart.
    const canAutoRestart = platform() === 'darwin' || platform() === 'linux' || platform() === 'win32'
    if (!canAutoRestart && !noRestart) {
      consola.warn(`Auto-restart isn't implemented for ${platform()} yet - installing the plugin and leaving Tabby alone.`)
      consola.info('Quit and reopen Tabby yourself once this finishes, then run `cctabs doctor`.')
    }

    const dir = pluginsDir()
    consola.info(`Tabby plugins dir: ${dir}`)
    mkdirSync(dir, { recursive: true })
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) writeFileSync(pkgPath, '{"private":true}\n')

    consola.info(`Installing ${TABBY_PLUGIN} from npm…`)
    const npm = spawnSync(
      'npm',
      ['install', '--legacy-peer-deps', '--silent', '--prefix', dir, TABBY_PLUGIN],
      { stdio: 'inherit' },
    )
    if (npm.status !== 0) {
      consola.error('npm install failed. Bail out before touching Tabby.')
      process.exit(npm.status ?? 1)
    }
    consola.success('Plugin installed.')

    if (noRestart || !canAutoRestart) {
      consola.info('Skipping restart. Quit and reopen Tabby manually, then run `cctabs doctor`.')
      return
    }

    // The same controlled restart as `cctabs restart-tabby`: every session is
    // saved and comes back, this one included. This used to resume only "the
    // newest session in this directory" (not necessarily this tab's) as a
    // --fork-session copy, while Tabby's own recovery could relaunch the
    // original beside it, and its quit could hang on the "still running" dialog.
    const adapter = requireAdapter()
    const selfTab = await saveAndClose(adapter, {
      reason: 'tabby-restart',
      yes,
      then: 'close this tab, quit Tabby, reopen it with the new plugin, and restore everything in a new tab.',
    })
    startRestartWorker(selfTab)
  },
})
