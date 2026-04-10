#!/usr/bin/env node
import updateNotifier from 'update-notifier'
import { run } from './commands/index.js'
import pkg from '../package.json'

// Non-blocking daily update check
updateNotifier({ pkg }).notify()

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
