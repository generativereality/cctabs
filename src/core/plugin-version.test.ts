import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { join } from 'path'

/**
 * `/api/health` reports PLUGIN_VERSION, and the CLI's `doctor` output and the
 * plugin's npm version are how a user reasons about what they have installed.
 *
 * This pair has now drifted twice — once a release behind, and once (via a
 * renumbered release) a release *ahead*, so a freshly published 0.1.4 announced
 * itself as 0.1.5. Nothing breaks, because behaviour is feature-detected through
 * `capabilities` rather than compared by version, which is exactly why the drift
 * survives review both times. Hence a test rather than another note.
 */
describe('tabby-plugin version', () => {
  // Standard ESM rather than Bun's `import.meta.dir`, so `npm run typecheck`
  // passes without depending on @types/bun being resolvable.
  const root = fileURLToPath(new URL('../../tabby-plugin/', import.meta.url))

  it('has PLUGIN_VERSION in step with its package.json', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version: string }
    const server = readFileSync(join(root, 'src', 'server.ts'), 'utf-8')
    const match = /const PLUGIN_VERSION = '([^']+)'/.exec(server)
    expect(match).not.toBeNull()
    expect(match![1]).toBe(pkg.version)
  })
})
