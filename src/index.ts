#!/usr/bin/env node
import updateNotifier from 'update-notifier'
import { run } from './commands/index.js'
import pkg from '../package.json'

// Non-blocking daily update check. We also print our own one-line warning
// that survives non-TTY capture (e.g. when Claude Code runs cctabs via a
// shell tool) — update-notifier's pretty banner is suppressed without a
// TTY, which means agent-driven invocations would never see "you're on an
// old build" otherwise.
const notifier = updateNotifier({ pkg })
notifier.notify()
if (notifier.update && notifier.update.latest !== notifier.update.current) {
  const { current, latest } = notifier.update
  process.stdout.write(
    `[cctabs] OUTDATED ${current} < ${latest} — run: npm install -g ${pkg.name}@latest\n`,
  )
}

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
