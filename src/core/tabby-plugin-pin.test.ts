import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { TABBY_PLUGIN } from './tabby-plugin-dir.js'

/**
 * The plugin pin lives in code, but the skill's install reference spells the same
 * version out by hand — for the agent following it manually, who never sees
 * TABBY_PLUGIN. Bumping the constant without the doc would leave the skill telling
 * every agent to install the release the CLI just moved off. Nothing would fail,
 * which is the same reason PLUGIN_VERSION drifted twice; hence a test.
 */
describe('tabby-cctabs pin', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it('is an exact version, never a range or a tag', () => {
    expect(TABBY_PLUGIN).toMatch(/^tabby-cctabs@\d+\.\d+\.\d+$/)
  })

  it('is the version the skill install reference tells agents to install', () => {
    const doc = read('../../skills/cctabs/references/install.md')
    const mentions = [...doc.matchAll(/tabby-cctabs(@[^\s`"']*)?/g)]
      .filter((m) => /npm install/.test(doc.slice(doc.lastIndexOf('\n', m.index!), m.index!)))
      .map((m) => m[0])
    expect(mentions.length).toBeGreaterThan(0)
    for (const m of mentions) expect(m).toBe(TABBY_PLUGIN)
  })
})
