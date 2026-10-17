import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexHistory, codexHistoryFiles, exportCodexHistory, codexAssistantTurns, importCodexHistory } from './codex-history.js'
import { rememberCodex, namedCodex } from './codex-state.js'
import { parseWindowsProcesses, isClaudeCommand } from './claude-procs.js'
import { isCodexCommand } from './codex.js'
import { matchCodexTabs, sameCodexCwd } from './codex-sessions.js'
import { cmdCodexPlaceholder } from './codex-placeholder.js'
import { placeholderSessions } from './suspend.js'
import { planRestart, auditRestart } from './restart-plan.js'

const a = '11111111-1111-1111-1111-111111111111', b = '22222222-2222-2222-2222-222222222222'
function temp(run: (dir: string) => void) { const d = mkdtempSync(join(tmpdir(), 'cx-parity-')); try { run(d) } finally { rmSync(d, { recursive: true, force: true }) } }
const meta = (id: string, more = {}) => ({ type: 'session_meta', ordinal: 0, payload: { id, timestamp: '2026-10-17T10:00:00Z', cwd: '/tmp', ...more } })
const message = (text: string, ordinal: number) => ({ type: 'response_item', ordinal, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } })
test('fork transcripts include inherited history only through the fork boundary, and export all ancestors', () => temp((d) => {
 const source = join(d, `rollout-${a}.jsonl`), fork = join(d, `rollout-${b}.jsonl`)
 writeFileSync(source, [meta(a),message('shared',1),message('later source-only',4)].map((r)=>JSON.stringify(r)).join('\n'))
 writeFileSync(fork, [meta(b,{history_base:{thread_id:a,end_ordinal_exclusive:3}}),message('fork-only',5)].map((r)=>JSON.stringify(r)).join('\n')+'\n{partial')
 const sessions = [{id:a,cwd:'/tmp',startedAt:1,file:source},{id:b,cwd:'/tmp',startedAt:2,file:fork}]
 expect(codexAssistantTurns(b,sessions).map((t)=>t.text)).toEqual(['shared','fork-only'])
 expect(codexHistoryFiles(b,sessions).map((s)=>s.id)).toEqual([a,b])
 const bundled=join(d,'bundle');exportCodexHistory(b,bundled,sessions)
 expect(readFileSync(join(bundled,`rollout-${a}.jsonl`),'utf8')).not.toContain('later source-only')
 const fullTarget=join(d,'keep-full'),localDate=join(fullTarget,'2026','10','18');mkdirSync(localDate,{recursive:true});writeFileSync(join(localDate,`rollout-${a}.jsonl`),readFileSync(source))
 importCodexHistory([join(bundled,`rollout-${a}.jsonl`)],fullTarget)
 expect(readFileSync(join(localDate,`rollout-${a}.jsonl`),'utf8')).toContain('later source-only')
 expect(() => readFileSync(join(fullTarget,'2026','10','17',`rollout-${a}.jsonl`))).toThrow()
 expect(()=>codexHistory(b,sessions.slice(1))).toThrow('Missing')
 const target=join(d,'import'); importCodexHistory([source,fork],target)
 expect(readFileSync(join(target,'2026','10','17',`rollout-${a}.jsonl`),'utf8')).toBe(readFileSync(source,'utf8'))
 writeFileSync(source,JSON.stringify(meta(a))+'\nchanged')
 expect(()=>importCodexHistory([source],target)).toThrow('already exists')
}))
test('saved Codex names survive tab close and rename; duplicate names refuse guessing', () => temp((d) => {
 rememberCodex({id:a,name:'old',cwd:'/tmp',tabId:'tab'},d)
 rememberCodex({id:a,name:'new',cwd:'/tmp',tabId:'tab'},d)
 expect(namedCodex('old',undefined,d)).toBeUndefined()
 expect(namedCodex('new',undefined,d)?.id).toBe(a)
 rememberCodex({id:b,name:'new',cwd:'/tmp'},d)
 expect(()=>namedCodex('new',undefined,d)).toThrow('Multiple')
}))
test('Windows CIM command lines preserve quoted executable paths and exact resume IDs', () => {
 const rows=parseWindowsProcesses(JSON.stringify([{pid:10,ppid:1,command:'cmd.exe'},{pid:11,ppid:10,command:`"C:\\Program Files\\Codex\\codex.exe" resume ${a}`,startedAt:'2026-10-17T10:00:00Z'}]))
 expect(isCodexCommand(rows[1].command)).toBe(true)
 expect(isCodexCommand('"C:\\Program Files\\Codex\\codex.exe" app-server')).toBe(false)
 expect(isClaudeCommand('"C:\\Program Files\\Claude\\claude.exe"')).toBe(true)
 expect(matchCodexTabs([{tabId:'t',name:'x',shellPid:10}],rows,[]).get('t')?.id).toBe(a)
 expect(sameCodexCwd('C:\\Users\\DEV','c:/users/dev')).toBe(true)
 expect(sameCodexCwd(String.raw`\\?\C:\Users\dev`,'c:/users/dev')).toBe(true)
 expect(sameCodexCwd(String.raw`\\?\UNC\server\share`,String.raw`\\server\share`)).toBe(true)
 const fresh=[rows[0],{...rows[1],command:'codex.exe',startedAt:1000}]
 expect(matchCodexTabs([{tabId:'t',name:'x',shellPid:10,cwd:'C:\\work'}],fresh,[{id:a,cwd:'c:/WORK',startedAt:1100,file:'x'}]).get('t')?.id).toBe(a)
})
test('cmd placeholder keeps hostile names encoded and exposes its identity on argv', () => {
 const body=cmdCodexPlaceholder({engine:'codex',sessionId:a,name:'%PATH% & "x"',dir:'C:\\work',recordFile:'C:\\r.json',extraFlags:[]})
 expect(body).not.toContain('%PATH%')
 expect(body).toEndWith(`cctabs-suspended ${a}`)
 expect(placeholderSessions([{pid:10,ppid:1,command:body}]).get(a)?.woken).toBe(false)
 expect(placeholderSessions([{pid:10,ppid:1,command:body},{pid:11,ppid:10,command:'codex.exe'}]).get(a)?.woken).toBe(true)
})
test('restart separates engines even for equal IDs and protects the caller', () => {
 const input={liveSessionPids:new Map([[a,[10]]]),codexLiveSessionPids:new Map([[a,[20]]]),shellPidClaude:new Map<string,number>(),nameOnly:new Set<string>(),selfPids:new Set([20])}
 const entries=[{engine:'claude' as const,name:'c',sessionId:a},{engine:'codex' as const,name:'x',sessionId:a}]
 const plan=planRestart(entries,input)
 expect(plan.targets.map((t)=>t.pids)).toEqual([[10]])
 expect(plan.protected.map((e)=>e.name)).toEqual(['x'])
 expect(auditRestart(entries,input.liveSessionPids,input.codexLiveSessionPids).ok).toHaveLength(2)
})

test('quoted Windows npm wrappers are not counted as a second native session', async () => {
 const { codexLiveSessionPids } = await import('./codex-sessions.js')
 const rows=[{pid:10,ppid:1,command:`"C:\\Program Files\\nodejs\\node.exe" "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" resume ${a}`},{pid:11,ppid:10,command:`"C:\\Program Files\\Codex\\codex.exe" resume ${a}`}]
 expect(codexLiveSessionPids(rows).get(a)).toEqual([11])
})

test('a Codex screen with unresolved identity never falls through to Claude lookup', async () => {
 const { tabAgent } = await import('./tab-agent.js')
 const block={tabid:'t',blockid:'b',view:'term',shellPid:10,meta:{'cmd:cwd':'/same'}}
 const adapter={scrollback:()=>'>_ OpenAI Codex\n› Ask Codex to do anything'} as any
 const data={tabsById:new Map([['t',[block]]]),tabNames:new Map([['t','same-name']]),blocks:[block],workspaces:[]} as any
 const result=tabAgent(adapter,data,'t',[],[])
 expect(result.engine).toBe('codex')
 expect(result.id).toBeUndefined()
})

test('explicit model and cwd override configured singleton flags instead of duplicating them', async () => {
 const { codexArgs } = await import('./codex.js')
 expect(codexArgs({model:'chosen',cwd:'C:\\new',extraFlags:['-m','old','--cd=old','--no-alt-screen']})).toEqual(['--no-alt-screen','-C','C:\\new','-m','chosen'])
 expect(codexArgs({forkId:a,model:'chosen',extraFlags:['--model=old']})).toEqual(['fork','-m','chosen',a])
})

test('cmd wake reopens the explicit Windows console device, never a cwd-relative filename', () => {
 const body=cmdCodexPlaceholder({engine:'codex',sessionId:a,name:'test',dir:'C:\\work',recordFile:'C:\\r.json',extraFlags:[]})
 const encoded=/Buffer.from\('([^']+)'/.exec(body)![1]
 const script=Buffer.from(encoded,'base64').toString()
 const literal=/const consoleInput=fs.openSync\(("[^"]+"),'r'\)/.exec(script)![1]
 expect(JSON.parse(literal)).toBe(String.fromCharCode(92,92,46,92)+'CONIN$')
})


test('POSIX symlink cwd aliases resolve the same fresh Codex session', () => {
 if (process.platform === 'win32') return
 temp((d) => {
  const actual=join(d,'actual'),alias=join(d,'alias');mkdirSync(actual);symlinkSync(actual,alias,'dir')
  expect(sameCodexCwd(actual,alias)).toBe(true)
  const rows=[{pid:10,ppid:1,command:'codex hello',cwd:actual,startedAt:1000}]
  expect(matchCodexTabs([{tabId:'t',name:'x',shellPid:10}],rows,[{id:a,cwd:alias,startedAt:1100,file:'x'}]).get('t')?.id).toBe(a)
 })
})

test('Codex status uses the current screen instead of stale PTY busy redraws', async () => {
 const { collectSessionRows } = await import('./session-rows.js')
 const block={tabid:'t',blockid:'b',view:'term',shellPid:10,meta:{'cmd:cwd':'/tmp'}}
 const adapter={getAllData:async()=>({tabsById:new Map([['t',[block]]]),tabNames:new Map([['t','codex']]),blocks:[block],workspaces:[{workspacedata:{oid:'w',name:'w',tabids:['t']},windowid:''}]}),currentTabId:()=>'',currentWorkspaceId:()=>'',scrollback:()=>'>_ OpenAI Codex\n• Working (1s • esc to interrupt)',screenText:async()=>'>_ OpenAI Codex\nWorked for 2s\n› Ask Codex to do anything'} as any
 const rows=await collectSessionRows(adapter,[{pid:10,ppid:1,command:`codex resume ${a}`}])
 expect(rows[0].sessions[0].engine).toBe('codex')
 expect(rows[0].sessions[0].status).toBe('idle')
})

test('a stale Claude argv name cannot override the target Codex screen on an older plugin', async () => {
 const { tabAgent } = await import('./tab-agent.js')
 const block={tabid:'t',blockid:'b',view:'term',meta:{'cmd:cwd':'/same'}}
 const adapter={scrollback:()=>'>_ OpenAI Codex\n› Ask Codex to do anything'} as any
 const data={tabsById:new Map([['t',[block]]]),tabNames:new Map([['t','reused-name']]),blocks:[block],workspaces:[]} as any
 const result=tabAgent(adapter,data,'t',[{pid:20,ppid:1,command:'claude --name reused-name'}],[])
 expect(result.engine).toBe('codex')
 expect(result.id).toBeUndefined()
})
