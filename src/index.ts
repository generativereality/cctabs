#!/usr/bin/env node
import updateNotifier from 'update-notifier'
import { run } from './commands/index.js'
import { outdatedBanner } from './core/version-check.js'
import pkg from '../package.json'

// Non-blocking daily update check. We also print our own one-line warning
// that survives non-TTY capture (e.g. when Claude Code runs cctabs via a
// shell tool) — update-notifier's pretty banner is suppressed without a
// TTY, which means agent-driven invocations would never see "you're on an
// old build" otherwise.
//
// stderr, never stdout: stdout is data (`cctabs sessions --json` is read by
// scripts, and a banner line ahead of the JSON breaks every one of them).
const notifier = updateNotifier({ pkg })
notifier.notify()
const banner = outdatedBanner(notifier.update, pkg.name)
if (banner) process.stderr.write(banner)

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
