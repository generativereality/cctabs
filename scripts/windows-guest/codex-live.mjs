import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
if (process.platform !== 'win32') throw new Error('Run this harness inside the disposable Windows guest only')
const base = 'C:\\Users\\dev\\cctabs-cx-validation'
const cli = process.env.CCTABS_TEST_CLI || 'C:\\tools\\cctabs-phase2-060\\node_modules\\@generativereality\\cctabs\\dist\\index.js'
const runId = Date.now().toString(36)
const result = { runId, version: spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).stdout.trim(), build: process.env.CCTABS_VALIDATION_BUILD || 'published-0.6.0', tests: [], startedAt: new Date().toISOString() }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (label, data) => writeFileSync(join(base, label + '.log'), data)
async function api(path, method = 'GET') {
  const r = await fetch('http://127.0.0.1:3300/api' + path, { method, headers: { connection: 'close' } })
  if (!r.ok) throw Error(`${method} ${path}: ${r.status} ${await r.text()}`)
  return r.json()
}
async function tabNamed(name) { return (await api('/tabs')).tabs.find((t) => t.customTitle === name) }
async function screen(tab) { const j = await api('/tabs/' + tab.uuid + '/screen'); return j.rows?.map((r) => r.text).join('\n') ?? '' }
async function close(tab) {
  if (!tab) return
  await api('/tabs/' + tab.uuid + '/close', 'POST')
  await until(async () => !(await api('/tabs')).tabs.some((t) => t.uuid === tab.uuid), 30000, 'tab closed ' + tab.uuid)
  await delay(300)
}
function run(args, shell, label) {
  const p = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 150000, env: { ...process.env, CCTABS_SHELL: shell } })
  const output = (p.stdout || '') + (p.stderr || '')
  log(label, output)
  assert.equal(p.status, 0, output)
  assert(!output.includes('Could not confirm Codex started'), output)
  return output
}
function rollouts(root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')) {
  const out = []
  if (!existsSync(root)) return out
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const file = join(root, ent.name)
    if (ent.isDirectory()) out.push(...rollouts(file))
    else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
      try { const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s)); out.push({ file, records, meta: records[0]?.payload }) } catch {}
    }
  }
  return out
}
function messages(rollout) {
  return rollout.records.flatMap((r) => r.type === 'response_item' && r.payload?.type === 'message' ? [{ role: r.payload.role, text: (r.payload.content ?? []).map((c) => c.text ?? '').join('') }] : [])
}
async function until(check, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(1000) }
  throw Error('Timeout: ' + label)
}
try {
  for (const [name, shell] of [['cmd', 'C:\\Windows\\System32\\cmd.exe'], ['bash', 'C:\\Program Files\\Git\\bin\\bash.exe']].filter(([name]) => !process.env.CCTABS_VALIDATION_SHELLS || process.env.CCTABS_VALIDATION_SHELLS.split(',').includes(name))) {
    const dir = join(base, 'real ' + name + ' & spaces ' + runId)
    mkdirSync(dir, { recursive: true })
    spawnSync('git.exe', ['init', dir], { encoding: 'utf8' })
    const marker = 'WIN_CCTABS_CODEX_060_' + name.toUpperCase() + '_' + runId
    const prompt = `Remember the marker ${marker} for my next message. Reply only READY_INITIAL. Do not run commands or tools. Literal test data: "double" 'single' %PATH% ^ & | !\nsecond line with trailing backslash \\`
    const title = 'cx-test-win-real-' + name + '-' + runId
    run(['new', title, dir, '--engine', 'codex', '--prompt', prompt], shell, title + '-new')
    let tab = await tabNamed(title)
    assert(tab, 'tab not created')
    log(title + '-screen-initial', await screen(tab))
    const rollout = await until(() => rollouts().find((r) => messages(r).some((m) => m.role === 'user' && m.text === prompt) && messages(r).some((m) => m.role === 'assistant' && m.text.includes('READY_INITIAL'))), 90000, 'initial prompt and response ' + name)
    const id = rollout.meta.session_id ?? rollout.meta.id
    result.tests.push({ shell: name, phase: 'fresh', pass: true, sessionId: id, cwd: rollout.meta.cwd, promptExact: true })
    await close(tab)
    if (name === 'bash') {
      run(['new', title, dir, '--engine', 'codex', '--resume', id, '--suspended'], shell, title + '-suspended')
      tab = await tabNamed(title)
      assert(tab)
      await until(async () => (await screen(tab)).includes('press Enter to resume'), 30000, 'placeholder painted')
      const record = JSON.parse(readFileSync(join(homedir(), '.config', 'cctabs', 'suspended', id + '.json'), 'utf8'))
      assert.equal(record.engine, 'codex')
      assert.equal(record.sessionId, id)
      run(['wake', tab.uuid], shell, title + '-wake')
      result.tests.push({ shell: name, phase: 'suspended-wake', pass: true, sessionId: id })
    } else {
      run(['new', title, dir, '--engine', 'codex', '--resume', id], shell, title + '-resume')
      tab = await tabNamed(title)
      assert(tab)
      result.tests.push({ shell: name, phase: 'resume-launch', pass: true, sessionId: id })
    }
    const followup = 'Return only the marker I told you in my previous message. Do not use tools.'
    run(['send', tab.uuid, '--', followup], shell, title + '-followup')
    await until(() => {
      const r = rollouts().find((r) => (r.meta.session_id ?? r.meta.id) === id)
      if (!r) return false
      const m = messages(r)
      const at = m.findLastIndex((m) => m.role === 'user' && m.text === followup)
      return at >= 0 && m.slice(at + 1).some((m) => m.role === 'assistant' && m.text.includes(marker))
    }, 90000, 'resumed context ' + name)
    result.tests.push({ shell: name, phase: 'resumed-context', pass: true, sessionId: id, marker })
    log(title + '-screen-final', await screen(tab))
    await close(tab)
    writeFileSync(join(base, 'real-validation.json'), JSON.stringify(result, null, 2))
  }
  const before = (await api('/tabs')).tabs.length
  const refusal = spawnSync(process.execPath, [cli, 'new', 'cx-test-win-refusal', base, '--engine', 'codex', '--resume', '00000000-0000-0000-0000-000000000000', '--suspended'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, CCTABS_SHELL: 'C:\\Windows\\System32\\cmd.exe' } })
  assert.notEqual(refusal.status, 0)
  assert.equal((await api('/tabs')).tabs.length, before)
  result.tests.push({ shell: 'cmd', phase: 'unsupported-placeholder-refusal', pass: true })
  log('cmd-placeholder-refusal', (refusal.stdout || '') + (refusal.stderr || ''))
  result.pass = true
} catch (e) { result.pass = false; result.error = String(e); process.exitCode = 1 }
finally {
  for (const tab of (await api('/tabs')).tabs.filter((t) => t.customTitle?.startsWith('cx-test-win-real-'))) {
    log(tab.customTitle + '-screen-cleanup', await screen(tab))
    await close(tab)
  }
  result.finishedAt = new Date().toISOString()
  writeFileSync(join(base, 'real-validation.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify(result, null, 2))
