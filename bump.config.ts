import { defineConfig } from 'bumpp'

export default defineConfig({
  // .claude-plugin/plugin.json isn't a file bumpp recognizes by name, so it
  // has to be listed explicitly — otherwise it silently falls out of sync
  // with package.json every release (as happened for 0.4.7), and
  // `scripts/sync-plugin.sh --check` (run from `prepack`) blocks publish
  // until someone notices and bumps it by hand.
  //
  // Listing `files` replaces bumpp's default list rather than extending it,
  // so package.json and package-lock.json must stay listed here too.
  files: [
    'package.json',
    'package-lock.json',
    '.claude-plugin/plugin.json',
  ],
})
