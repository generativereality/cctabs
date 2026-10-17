import { codexLaunchBody } from './open-codex.js'
import type { PlaceholderSpec } from './suspend.js'

/**
 * cmd sees only a fixed expression and base64; readline supplies the wake nonce.
 * Close readline's console handle BEFORE spawning the TUI, then reopen the explicit Windows device \\.\CONIN$.
 * A pending Windows ReadConsole otherwise steals the TUI's input while the
 * parent blocks in spawnSync: the TUI looks ready, but every send disappears.
 */
export function cmdCodexPlaceholder(spec: PlaceholderSpec): string {
  if (spec.engine !== 'codex') throw new Error('cmd.exe placeholders currently support Codex; use Git Bash for Claude')
  const launch = codexLaunchBody({ resumeId: spec.sessionId, cwd: spec.dir, extraFlags: spec.extraFlags, readClaudeMd: spec.readClaudeMd }, { posix: false }, 'win32')
  const encoded = /Buffer.from\('([A-Za-z0-9+/=]+)'/.exec(launch)![1]
  const consoleDevice = String.raw`\\.\CONIN$`
  const script = `
const fs=require('node:fs'),rl=require('node:readline'),cp=require('node:child_process');
console.log('\\x1b[H\\x1b[2J\\n  ⏸ cctabs suspended — '+${JSON.stringify(spec.name)}+'\\n    press Enter to resume');
const input=rl.createInterface({input:process.stdin,output:process.stdout});
input.on('SIGINT',()=>{});
input.once('line',(nonce)=>{
input.close();
process.stdin.once('close',()=>setImmediate(()=>{
try{fs.unlinkSync(${JSON.stringify(spec.recordFile)})}catch{}
console.log('\\n▶ cctabs: resuming '+${JSON.stringify(spec.name)}+' ('+nonce+')');
const file=${JSON.stringify(spec.recordFile + '.launch.cjs')};
fs.writeFileSync(file,Buffer.from('${encoded}','base64'));
const consoleInput=fs.openSync(${JSON.stringify(consoleDevice)},'r');
try{const child=cp.spawnSync(process.execPath,[file],{stdio:[consoleInput,1,2],shell:false});process.exitCode=child.status??1}finally{fs.closeSync(consoleInput);try{fs.unlinkSync(file)}catch{}}
}));
process.stdin.destroy();
});`.trim()
  return `node -e eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString()) cctabs-suspended ${spec.sessionId}`
}
