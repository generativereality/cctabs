#!/usr/bin/env node
/**
 * Regenerate docs/changelog.md from the repo's CHANGELOG.md.
 *
 * The docs page used to be a hand-kept copy and quietly fell six releases
 * behind (it still ended at 0.4.0 while the CLI was on 0.4.10). Everything
 * above the `<!-- releases -->` marker is the page's own front matter and
 * install blurb and is preserved; everything below is replaced with the
 * release sections from CHANGELOG.md, which stays the source of truth.
 *
 * Run via `npm run sync-changelog` in docs/ (also wired into `docs:build`).
 */
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const pagePath = join(here, '..', 'changelog.md')
const sourcePath = join(here, '..', '..', 'CHANGELOG.md')
const MARKER = '<!-- releases -->'

const page = readFileSync(pagePath, 'utf-8')
const markerAt = page.indexOf(MARKER)
if (markerAt === -1) {
  console.error(`docs/changelog.md is missing the ${MARKER} marker — add it above the first release heading.`)
  process.exit(1)
}

const source = readFileSync(sourcePath, 'utf-8')
const firstRelease = source.search(/^## /m)
if (firstRelease === -1) {
  console.error('CHANGELOG.md has no `## <version>` headings.')
  process.exit(1)
}

const next = page.slice(0, markerAt + MARKER.length) + '\n\n' + source.slice(firstRelease).trimEnd() + '\n'
if (next === page) {
  console.log('docs/changelog.md already up to date')
} else {
  writeFileSync(pagePath, next)
  console.log('docs/changelog.md regenerated from CHANGELOG.md')
}
