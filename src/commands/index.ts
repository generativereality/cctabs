import { inlineValueOptions } from '../core/cli-argv.js'
import type { ArgSpecLike } from '../core/unknown-options.js'
import { cli, define } from 'gunshi'
import { consola } from 'consola'
import pkg from '../../package.json'
import { findUnknownOptions, unknownOptionMessage } from '../core/unknown-options.js'
import { protectArgv, restoreParsed } from '../core/argv-text.js'
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
import { transcriptCommand } from './transcript.js'
import { sendCommand } from './send.js'
import { configCommand } from './config-cmd.js'
import { restoreCommand } from './restore.js'
import { manifestCommand } from './manifest.js'
import { restartCommand } from './restart.js'
import { backendsCommand } from './backends.js'
import { doctorCommand } from './doctor.js'
import { installTabbyPluginCommand } from './install-tabby-plugin.js'
import { exportCommand } from './export-cmd.js'
import { importCommand } from './import-cmd.js'
import { profileCopyCommand } from './profile-copy.js'
import { sortCommand } from './sort.js'
import { restartTabbyCommand, prepareRebootCommand, restartTabbyWorkerCommand } from './restart-tabby.js'
import { suspendCommand, wakeCommand } from './suspend.js'

// Default command: show sessions (most common use)
const defaultCommand = define({
  name: 'cctabs',
  description: pkg.description,
  args: {},
  async run() {
    await sessionsCommand.run?.call(this, { values: {} } as never)
  },
})

/**
 * Refuse to run a command that was given an option it doesn't declare.
 *
 * Wrapped here, once, rather than asserted at the top of each command: gunshi
 * accepts an undeclared flag silently, and the failure it produces — a command
 * that reports success having quietly ignored half of what it was asked —
 * is exactly the kind nobody goes looking for. A new command gets this by
 * being in the map below, with nothing to remember.
 */
export function rejectUnknownOptions<T extends { name?: string; args?: unknown; run?: unknown }>(command: T): T {
  const original = command.run
  if (typeof original !== 'function') return command
  return {
    ...command,
    run: function (this: unknown, frozen: Record<string, unknown>) {
      // Text the argv was disguised in (see run() below) comes back out as the
      // text it was. A copy: gunshi deep-freezes the context.
      const ctx = { ...frozen }
      for (const key of ['values', 'positionals', 'rest', '_', 'tokens']) {
        if (key in ctx) ctx[key] = restoreParsed(ctx[key])
      }
      const unknown = findUnknownOptions(
        (ctx.tokens ?? []) as never,
        (ctx.args ?? {}) as never,
      )
      if (unknown.length > 0) {
        consola.error(unknownOptionMessage(command.name ?? 'cctabs', unknown))
        process.exit(1)
      }
      return (original as (c: unknown) => unknown).call(this, ctx)
    },
  } as T
}

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
  ['transcript', transcriptCommand],
  // `findings` reads better at a call site that is asking "what did that tab
  // work out?", which is the question the command exists for.
  ['findings', transcriptCommand],
  ['send', sendCommand],
  ['config', configCommand],
  ['restore', restoreCommand],
  ['manifest', manifestCommand],
  ['restart', restartCommand],
  ['restart-tabby', restartTabbyCommand],
  ['prepare-reboot', prepareRebootCommand],
  ['restart-tabby-worker', restartTabbyWorkerCommand],
  ['backends', backendsCommand],
  ['doctor', doctorCommand],
  ['install-tabby-plugin', installTabbyPluginCommand],
  ['export', exportCommand],
  ['import', importCommand],
  ['profile-copy', profileCopyCommand],
  ['sort', sortCommand],
  ['suspend', suspendCommand],
  ['wake', wakeCommand],
].map(([name, command]) => [name, rejectUnknownOptions(command as never)] as const) as Array<[string, never]>)

export async function run(): Promise<void> {
  // Text that merely CONTAINS `--` (a message quoting a flag) is disguised
  // before gunshi's tokenizer can take it for an option (core/argv-text.ts);
  // then declared value options are inlined as `--name=value`.
  const raw = protectArgv(process.argv.slice(2))
  const command = subCommands.get(raw[0]) as { args?: Record<string, ArgSpecLike> } | undefined
  await cli(inlineValueOptions(raw, command?.args ?? {}), defaultCommand, {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    subCommands,
    // Suppress gunshi's default banner so `--json` output stays parseable
    // and shells don't see noise when piping commands together.
    renderHeader: null,
    renderValidationErrors: async (_ctx, error) => { process.exitCode = 1; return error.errors.map((e: Error) => e.message).join('\n') },
  })
}
