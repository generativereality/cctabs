import { cli, define } from 'gunshi'
import pkg from '../../package.json'
import { sessionsCommand } from './sessions.js'
import { listCommand } from './list.js'
import { newCommand } from './new.js'
import { resumeCommand } from './resume.js'
import { forkCommand } from './fork.js'
import { closeCommand } from './close.js'
import { renameCommand } from './rename.js'
import { scrollbackCommand } from './scrollback.js'
import { sendCommand } from './send.js'
import { configCommand } from './config-cmd.js'
import { restoreCommand } from './restore.js'
import { backendsCommand } from './backends.js'

// Default command: show sessions (most common use)
const defaultCommand = define({
  name: 'cctabs',
  description: pkg.description,
  args: {},
  async run() {
    await sessionsCommand.run?.call(this, { args: {} } as never)
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
  ['scrollback', scrollbackCommand],
  ['send', sendCommand],
  ['config', configCommand],
  ['restore', restoreCommand],
  ['backends', backendsCommand],
])

export async function run(): Promise<void> {
  await cli(process.argv.slice(2), defaultCommand, {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    subCommands,
  })
}
