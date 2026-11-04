import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { requireAdapter } from './adapter.js'
import { resolveTabShell, tabLaunchArgv, shellQuoteArg } from './shell.js'
import { readTab } from './open-session.js'
import { HARNESS_BIN, HARNESS_INSTALL, HARNESS_LABEL, harnessArgs, type Harness } from './harness.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface OpenHarnessOptions {
  engine: Harness
  tabName: string
  dir: string
  /** The first turn, on argv: each harness runs it as the first turn of its TUI. */
  prompt?: string
  resumeId?: string
  model?: string
  afterActive?: boolean
  color?: string | null
  background?: boolean
}

/** What a shell prints when the program is not installed. */
export function harnessMissing(screen: string, engine: Harness): boolean {
  const word = HARNESS_BIN[engine].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(command not found: ${word}\\b|\\b${word}: command not found|'${word}' is not recognized|${HARNESS_LABEL[engine]} was not found on PATH)`, 'i').test(screen)
}

/**
 * Open a tab running opencode, opencode 2, pi, Hermes or Grok Build.
 *
 * Like Codex, the prompt rides on argv, so nothing is typed into the TUI and
 * there is no paste to confirm. None of the three documents what its ready
 * screen says, so cctabs does not wait for one; it watches the first seconds
 * only for the shell saying the program is not installed.
 */
export async function openHarnessSession(opts: OpenHarnessOptions): Promise<string> {
  const requestedDir = resolve(opts.dir.replace(/^~/, homedir()))
  if (!existsSync(requestedDir)) throw new Error(`Directory does not exist: ${requestedDir}`)
  const dir = realpathSync.native(requestedDir)
  const adapter = requireAdapter()
  if (!adapter.openTabDirect) throw new Error(`${HARNESS_LABEL[opts.engine]} tabs need the Tabby plugin.`)

  const shell = resolveTabShell()
  const args = harnessArgs(opts.engine, { prompt: opts.prompt, resumeId: opts.resumeId, model: opts.model, name: opts.tabName })
  const { blockId, tabId } = await adapter.openTabDirect({
    cwd: dir,
    title: opts.tabName,
    command: shell.command,
    args: tabLaunchArgv(shell, harnessLaunchBody(opts.engine, args, shell)),
    afterActive: opts.afterActive,
    color: opts.color,
    background: opts.background,
  })

  for (let i = 0; i < 6; i++) {
    await sleep(700)
    const screen = await readTab(adapter, blockId, 40)
    if (harnessMissing(screen, opts.engine)) {
      throw new Error(`${HARNESS_LABEL[opts.engine]} is not installed in the tab's shell. Install it with: ${HARNESS_INSTALL[opts.engine]}`)
    }
  }
  return tabId
}

/**
 * The shell line that starts the harness. On POSIX every word is quoted. On
 * Windows no user text reaches cmd or Git Bash (see `codexLaunchBody` for the
 * failures that taught this): an encoded Node bootstrap finds the program and
 * starts it with an argv array and shell:false — a native `.exe` directly, an
 * npm `.cmd` shim through the script the shim points at, since a `.cmd` cannot
 * be spawned without a shell.
 */
export function harnessLaunchBody(engine: Harness, args: string[], shell: { posix: boolean }, platform: NodeJS.Platform = process.platform): string {
  if (shell.posix && platform !== 'win32') return [HARNESS_BIN[engine], ...args.map(shellQuoteArg)].join(' ')
  const script = `
const {spawnSync}=require('node:child_process');
const {join,dirname}=require('node:path');
const {existsSync,readFileSync}=require('node:fs');
const args=${JSON.stringify(args)};
const find=(name)=>(spawnSync('where.exe',[name],{encoding:'utf8'}).stdout||'').split(/\\r?\\n/).map(p=>p.trim()).find(Boolean);
let cmd=find(${JSON.stringify(HARNESS_BIN[engine] + '.exe')}),pre=[];
if(!cmd){const shim=find(${JSON.stringify(HARNESS_BIN[engine] + '.cmd')});const m=shim&&[...readFileSync(shim,'utf8').matchAll(/"%~?dp0%?\\\\([^"]+)"/g)].pop();const entry=m&&join(dirname(shim),m[1]);if(entry&&existsSync(entry)){cmd=process.execPath;pre=[entry]}}
if(!cmd){console.error(${JSON.stringify(`${HARNESS_LABEL[engine]} was not found on PATH. Install it with: ${HARNESS_INSTALL[engine]}`)});process.exit(1)}
const child=spawnSync(cmd,[...pre,...args],{stdio:'inherit',shell:false});
process.exit(child.status??1);
`.trim()
  const encoded = Buffer.from(script).toString('base64')
  const expression = shell.posix
    ? 'eval(Buffer.from(`' + encoded + '`,`base64`).toString())'
    : "eval(Buffer.from('" + encoded + "','base64').toString())"
  return `node -e ${shell.posix ? shellQuoteArg(expression) : expression}`
}
