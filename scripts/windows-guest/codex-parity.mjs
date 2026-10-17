// Run only in the snapshotted, disposable Windows guest; see README.md.
import fs from 'node:fs'
import cp from 'node:child_process'
import path from 'node:path'
import assert from 'node:assert/strict'
if (process.platform !== 'win32') throw new Error('Windows guest only')
const root = 'C:\\Users\\dev\\cctabs-cx-validation'
const cli = process.env.CCTABS_TEST_CLI || 'C:\\tools\\cctabs-phase2-060\\node_modules\\@generativereality\\cctabs\\dist\\index.js'
const runId = Date.now().toString(36), dir = path.join(root, 'parity ' + runId), name = 'cx-win-parity-' + runId, renamed = name + '-%PATH%-&'
fs.mkdirSync(dir, { recursive: true })
const result = { runId, build: process.env.CCTABS_VALIDATION_BUILD || 'unreleased', tests: [], pass: false }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
async function api(route, method = 'GET') {
  const response = await fetch('http://127.0.0.1:3300/api' + route, { method, headers: { connection: 'close' } })
  if (!response.ok) throw new Error(`${route}: ${response.status}`)
  return response.json()
}
async function tabs() { return (await api('/tabs')).tabs }
async function named(n) { return (await tabs()).find((t) => t.customTitle === n) }
async function screen(t) { return (await api('/tabs/' + t.uuid + '/screen')).rows.map((r) => r.text).join('\n') }
async function until(f) { for (let i = 0; i < 90; i++) { const value = await f(); if (value) return value; await delay(1000) } throw new Error('Timeout') }
async function close(t) { await api('/tabs/' + t.uuid + '/close', 'POST'); await until(async () => !(await tabs()).some((x) => x.uuid === t.uuid)) }
function call(args, label) {
  const p = cp.spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 180000, env: { ...process.env, CCTABS_TERMINAL: 'tabby', CCTABS_SHELL: 'C:\\Windows\\System32\\cmd.exe' } })
  fs.writeFileSync(path.join(root, 'parity-' + label + '.log'), (p.stdout ?? '') + (p.stderr ?? ''))
  assert.equal(p.status, 0, p.stdout + p.stderr)
  return p.stdout
}
try {
  call(['new', name, dir, '--engine', 'codex', '--model', 'gpt-6-luna', '--prompt', 'Reply only WIN_PARITY_READY. Do not use tools.'], 'new')
  let tab = await named(name); assert(tab)
  await until(async () => (await screen(tab)).includes('• WIN_PARITY_READY'))
  const sessions = JSON.parse(call(['sessions', '--json'], 'sessions')).workspaces.flatMap((w) => w.sessions)
  const row = sessions.find((r) => r.tab_id === tab.uuid)
  assert.equal(row.engine, 'codex'); assert(row.session_id)
  result.tests.push('Windows fresh session identity via CIM')
  call(['rename', tab.uuid, renamed], 'rename')
  const transcript = JSON.parse(call(['transcript', tab.uuid, '--json'], 'transcript'))
  assert.equal(transcript.session_id, row.session_id); assert(transcript.turns.some((t) => t.text === 'WIN_PARITY_READY'))
  result.tests.push('Codex rename and transcript')
  await close(tab)
  call(['new', renamed, dir, '--engine', 'codex', '--resume', row.session_id, '--suspended'], 'cmd-placeholder')
  tab = await named(renamed); assert(tab)
  await until(async () => (await screen(tab)).includes('press Enter to resume'))
  call(['wake', tab.uuid], 'cmd-wake')
  assert(call(['send', tab.uuid, '--verify', '--', 'Reply only WIN_PARITY_WOKEN. Do not use tools.'], 'send').includes('and verified'))
  await until(async () => (await screen(tab)).includes('• WIN_PARITY_WOKEN'))
  assert.equal(JSON.parse(call(['transcript', tab.uuid, '--json'], 'after-wake')).session_id, row.session_id)
  result.tests.push('cmd.exe encoded placeholder wake and same conversation')
  call(['suspend', tab.uuid], 'cmd-active-suspend')
  await until(async () => (await screen(tab)).includes('press Enter to resume'))
  assert(call(['send', tab.uuid, '--', 'Reply only WIN_PARITY_RESUSPENDED. Do not use tools.'], 'after-active-suspend-send').includes('and verified'))
  await until(async () => (await screen(tab)).includes('• WIN_PARITY_RESUSPENDED'))
  assert.equal(JSON.parse(call(['transcript', tab.uuid, '--json'], 'after-active-suspend')).session_id, row.session_id)
  result.tests.push('Active cmd.exe suspend and send-triggered wake verify delivery in Codex history')
  await close(tab)
  call(['resume', renamed], 'closed-resume')
  tab = await named(renamed); assert(tab)
  assert.equal(JSON.parse(call(['transcript', tab.uuid, '--json'], 'after-resume')).session_id, row.session_id)
  result.tests.push('Closed Codex resume by saved name')
  await close(tab)
  const archive = path.join(root, 'mac-codex-v2.tar.gz')
  if (fs.existsSync(archive)) {
    const target = path.join(root, 'imported ' + runId); fs.mkdirSync(target, { recursive: true })
    call(['import', archive, '--cwd', target], 'cross-machine-import')
    const imported = (await tabs()).find((t) => t.customTitle?.startsWith('cx-parity-renamed-'))
    assert(imported)
    const history = JSON.parse(call(['transcript', imported.uuid, '--turns', '20', '--json'], 'imported-transcript'))
    assert.equal(history.engine, 'codex'); assert(history.turns.some((t) => t.text.startsWith('FORK_PARITY_')))
    assert.equal(history.cwd.toLowerCase(), target.toLowerCase())
    const inherited = history.turns.find((t) => t.text.startsWith('PARITY_'))?.text
    assert(inherited)
    const prefix = 'WIN_IMPORT_' + runId + ':'
    call(['send', imported.uuid, '--', `Reply in exact format ${prefix}<marker>, with no spaces, replacing <marker> with the PARITY marker from the original inherited conversation. Do not use tools.`], 'imported-followup')
    await until(async () => (await screen(imported)).includes(prefix + inherited))
    const answered = JSON.parse(call(['transcript', imported.uuid, '--turns', '20', '--json'], 'imported-answered'))
    assert(answered.turns.some((t) => t.text === prefix + inherited))
    result.tests.push('Mac fork archive imports with inherited history and Windows cwd override')
    await close(imported)
  }
  result.pass = true
} catch (e) { result.error = String(e); process.exitCode = 1 }
finally {
  for (const t of (await tabs()).filter((t) => [name, renamed].includes(t.customTitle))) { fs.writeFileSync(path.join(root, 'parity-cleanup-screen.log'), await screen(t)); await close(t) }
  fs.writeFileSync(path.join(root, 'parity-result.json'), JSON.stringify(result, null, 2))
  console.log(result)
}
