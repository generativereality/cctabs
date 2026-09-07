import { cli, define } from 'gunshi'
import pkg from '../../package.json'
import { sessionsCommand } from './sessions.js'
import { listCommand } from './list.js'
import { newCommand } from './new.js'
import { resumeCommand } from './resume.js'
import { forkCommand } from './fork.js'
import { closeCommand } from './close.js'
import { renameCommand } from './rename.js'
import { colorCommand } from './color.js'
import { whoamiCommand } from './whoami.js'
import { scrollbackCommand } from './scrollback.js'
import { sendCommand } from './send.js'
import { configCommand } from './config-cmd.js'
import { restoreCommand } from './restore.js'
import { backendsCommand } from './backends.js'
import { doctorCommand } from './doctor.js'
import { installTabbyPluginCommand } from './install-tabby-plugin.js'
import { exportCommand } from './export-cmd.js'
import { importCommand } from './import-cmd.js'
import { profileCopyCommand } from './profile-copy.js'
import { sortCommand } from './sort.js'

// Default command: show sessions (most common use)
const defaultCommand = define({
  name: 'cctabs',
  description: pkg.description,
  args: {},
  async run() {
    await sessionsCommand.run?.call(this, { values: {} } as never)
  },
})

const subCommands = new Map([
  ['sessions', sessionsCommand],
  ['list', listCommand],
  ['ls', listCommand],
  ['new', newCommand],
  ['resume', resumeCommand],
  ['fork', forkCommand],
  ['close', closeCommand],
  ['rename', renameCommand],
  ['color', colorCommand],
  ['whoami', whoamiCommand],
  ['scrollback', scrollbackCommand],
  ['send', sendCommand],
  ['config', configCommand],
  ['restore', restoreCommand],
  ['backends', backendsCommand],
  ['doctor', doctorCommand],
  ['install-tabby-plugin', installTabbyPluginCommand],
  ['export', exportCommand],
  ['import', importCommand],
  ['profile-copy', profileCopyCommand],
  ['sort', sortCommand],
])

export async function run(): Promise<void> {
  await cli(process.argv.slice(2), defaultCommand, {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    subCommands,
    // Suppress gunshi's default banner so `--json` output stays parseable
    // and shells don't see noise when piping commands together.
    renderHeader: null,
  })
}
