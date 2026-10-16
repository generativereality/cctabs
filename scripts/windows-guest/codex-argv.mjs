import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
if (process.platform !== 'win32') throw new Error('Run this harness inside the disposable Windows guest only')
const base = 'C:\\Users\\dev\\cctabs-cx-validation'
const cli = process.env.CCTABS_TEST_CLI || 'C:\\tools\\cctabs-phase2-060\\node_modules\\@generativereality\\cctabs\\dist\\index.js'
const cwd = join(base, 'work space & directory')
mkdirSync(cwd, { recursive: true })
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(path, method = 'GET') {
  const r = await fetch('http://127.0.0.1:3300/api' + path, { method, headers: { connection: 'close' } })
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${await r.text()}`)
  return r.status === 204 ? null : r.json()
}
async function ownTabs() { return (await api('/tabs')).tabs.filter((t) => t.customTitle?.startsWith('cx-test-win-argv-')) }
const where = spawnSync('where.exe', ['codex.cmd'], { encoding: 'utf8' })
const shim = where.stdout.trim().split(/\r?\n/)[0]
assert(shim, 'npm Codex shim must be installed')
const entry = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
assert(existsSync(entry), `Missing npm entry: ${entry}`)
const backup = join(base, 'codex-entry-backup.js')
copyFileSync(entry, backup)
const fixtures = [
  'literal "double quotes" and \'single quotes\'',
  'percent %PATH% %CX_UNDEFINED% and bang !PATH!',
  'caret ^ ampersand & pipe | redirection < > and parentheses ( )',
  'first line\nsecond line\r\nthird line',
  'backslash \\ quote " trailing \\\\',
  'unicode \u00e5 \u4e2d\u6587 \ud83d\ude42',
  'all " \' %PATH% ^ & | !\nlast line \\',
]
const result = { version: spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout.trim(), build: process.env.CCTABS_VALIDATION_BUILD || 'published-0.6.0', tests: [], startedAt: new Date().toISOString() }
writeFileSync(join(base, 'argv-validation.json'), JSON.stringify(result, null, 2))
try {
  copyFileSync(join(base, 'codex-argv-probe.mjs'), entry)
  for (const [shellName, shell] of [['cmd', 'C:\\Windows\\System32\\cmd.exe'], ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']].filter(([name]) => !process.env.CCTABS_VALIDATION_SHELLS || process.env.CCTABS_VALIDATION_SHELLS.split(',').includes(name))) {
    for (const [n, prompt] of fixtures.entries()) {
      const name = `cx-test-win-argv-${shellName}-${n}`
      const outputFile = join(base, 'argv-result.json')
      if (existsSync(outputFile)) unlinkSync(outputFile)
      const launched = spawnSync(process.execPath, [cli, 'new', name, cwd, '--engine', 'codex', '--prompt', prompt], {
        encoding: 'utf8', timeout: 75000, env: { ...process.env, CCTABS_SHELL: shell },
      })
      const output = (launched.stdout || '') + (launched.stderr || '')
      writeFileSync(join(base, name + '.log'), output)
      let evidence
      try {
        assert.equal(launched.status, 0, output)
        assert(!output.includes('Could not confirm Codex started'), output)
        assert(existsSync(outputFile), output)
        evidence = JSON.parse(readFileSync(outputFile, 'utf8'))
        assert.equal(evidence.argv.at(-1), prompt)
        assert.equal(evidence.cwd.toLowerCase(), cwd.toLowerCase())
        result.tests.push({ shell: shellName, fixture: n, pass: true, ...evidence })
      } catch (e) { result.tests.push({ shell: shellName, fixture: n, pass: false, error: String(e), evidence, output }); throw e }
      finally {
        writeFileSync(join(base, 'argv-validation.json'), JSON.stringify(result, null, 2))
        for (const tab of await ownTabs()) await api('/tabs/' + tab.uuid + '/close', 'POST')
      }
      await delay(300)
    }
  }
  result.pass = true
} catch (e) { result.pass = false; result.error = String(e); process.exitCode = 1 }
finally {
  copyFileSync(backup, entry)
  result.entryRestored = readFileSync(entry).equals(readFileSync(backup))
  result.finishedAt = new Date().toISOString()
  writeFileSync(join(base, 'argv-validation.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify(result, null, 2))
