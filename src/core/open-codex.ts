import { tabAgent } from './tab-agent.js'
import { rememberCodex } from './codex-state.js'
import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { consola } from 'consola'
import { requireAdapter } from './adapter.js'
import { loadConfig } from './config.js'
import { resolveTabShell, tabLaunchArgv, shellQuoteArg } from './shell.js'
import { readTab } from './open-session.js'
import { codexArgs, codexStartupSettled, codexTrustDialog, codexStatus } from './codex.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface OpenCodexOptions {
  tabName: string
  dir: string
  /** The first turn. Passed on argv: Codex runs it at once, nothing is typed. */
  prompt?: string
  resumeId?: string
  forkId?: string
  model?: string
  afterActive?: boolean
  color?: string | null
  /** Keep the calling tab in front (see `openTabDirect`'s `background`). */
  background?: boolean
}

/**
 * Open a tab running OpenAI's Codex CLI instead of Claude Code.
 *
 * Simpler than the Claude path in one way, because the prompt rides on argv:
 * no paste, no confirming it landed, no Enter to land. Codex still shows its
 * folder-trust prompt first in a git folder — even with a prompt on argv — and
 * holds the prompt until it is answered. Its default option IS "Trust and
 * continue" (Claude's default exits), so for the directory the caller named
 * explicitly, cctabs presses Enter once it has seen the cursor there.
 */
export async function openCodexSession(opts: OpenCodexOptions): Promise<string> {
  const requestedDir = resolve(opts.dir.replace(/^~/, homedir()))
  if (!existsSync(requestedDir)) throw new Error(`Directory does not exist: ${requestedDir}`)
  const dir = realpathSync.native(requestedDir)
  const adapter = requireAdapter()
  if (!adapter.openTabDirect) throw new Error('Codex tabs need the Tabby plugin.')

  const shell = resolveTabShell()

  const readClaudeMd = existsSync(join(dir, 'CLAUDE.md')) && !existsSync(join(dir, 'AGENTS.md'))
  const body = codexLaunchBody({ ...opts, cwd: dir, readClaudeMd }, shell)

  const { blockId, tabId } = await adapter.openTabDirect({
    cwd: dir,
    title: opts.tabName,
    command: shell.command,
    args: tabLaunchArgv(shell, body),
    afterActive: opts.afterActive,
    color: opts.color,
    background: opts.background,
  })
  if (readClaudeMd) consola.info('This folder has a CLAUDE.md and no AGENTS.md, so Codex is told to read CLAUDE.md.')

  const remember = async () => {
    if (opts.resumeId) rememberCodex({ id: opts.resumeId, name: opts.tabName, cwd: dir, tabId })
    else { try { tabAgent(adapter, await adapter.getAllData(), tabId) } catch (e) { consola.warn(`Codex identity not yet saved: ${(e as Error).message}`) } }
    return tabId
  }

  // Get past the trust prompt, then confirm Codex is up.
  const deadline = Date.now() + 45_000
  let answered = false
  const frames: string[] = []
  while (Date.now() < deadline) {
    await sleep(700)
    const screen = await readTab(adapter, blockId, 40)
    if (/Usage: codex/.test(screen) && /(?:^|\n)\s*error:/.test(screen) && codexStatus(screen) === undefined) throw new Error(`Codex rejected its launch arguments: ${screen.trim()}`)
    frames.push(screen)
    if (frames.length > 3) frames.shift()
    const trust = codexTrustDialog(screen)
    if (trust.visible) {
      if (answered) continue
      if (!trust.onTrust) {
        consola.warn('Codex is asking whether to trust this folder, and the cursor is not on "Trust and continue". Left for you to answer in the tab.')
        return remember()
      }
      await sleep(400) // let the dialog's key handler attach
      // Windows can replace this frame with its sandbox setup question.
      // An Enter authorized for folder trust must not answer a different dialog.
      const current = codexTrustDialog(await readTab(adapter, blockId, 40))
      if (!current.visible || !current.onTrust) { frames.length = 0; continue }
      await adapter.sendInput(blockId, '\r')
      answered = true
      continue
    }
    if (codexStartupSettled(frames)) return remember()
  }
  consola.warn('Could not confirm Codex started within 45s — check the tab. (Signed out? `codex login`.)')
  return remember()
}

/**
 * cmd expands %, ! and metacharacters even inside several quoting forms.
 * Keep all user argv out of its parser: an encoded Node bootstrap invokes the
 * npm Codex JS entry directly with an argv array and shell:false. The fixed
 * bootstrap token contains only base64 characters; newlines stay in JSON.
 */
export function codexLaunchBody(
  opts: Parameters<typeof codexArgs>[0] & { cwd?: string },
  shell: { posix: boolean },
  platform: NodeJS.Platform = process.platform,
): string {
  const args = codexArgs({ extraFlags: loadConfig().codex.flags, ...opts })
  if (shell.posix && platform !== 'win32') return ['codex', ...args.map(shellQuoteArg)].join(' ')
  // Git Bash also crosses the Windows command-line boundary: literal CRLF
  // and trailing backslashes in its -c script were changed before Codex saw
  // them. Keep user data encoded for BOTH Windows shell paths.
  const script = `
const {spawnSync}=require('node:child_process');
const {join,dirname}=require('node:path');
const {existsSync}=require('node:fs');
${opts.cwd ? `process.chdir(${JSON.stringify(opts.cwd)});` : ''}
const args=${JSON.stringify(args)};
const find=(name)=>(spawnSync('where.exe',[name],{encoding:'utf8'}).stdout||'').split(/\\r?\\n/).map(p=>p.trim()).find(Boolean);
const shim=find('codex.cmd');
const entry=shim&&join(dirname(shim),'node_modules','@openai','codex','bin','codex.js');
const useNpm=entry&&existsSync(entry);
const native=useNpm?undefined:find('codex.exe');
if(!useNpm&&!native){console.error('Codex was not found on PATH. Install it with npm i -g @openai/codex');process.exit(1)}
const child=spawnSync(useNpm?process.execPath:native,useNpm?[entry,...args]:args,{stdio:'inherit',shell:false});
process.exit(child.status??1);
`.trim()
  const encoded = Buffer.from(script).toString('base64')
  // ConPTY's CRT quoting makes embedded double quotes reach Node -e as part
  // of its value. A quoted cmd bootstrap evaluated a string and silently
  // exited. Git Bash gets a single-quoted expression with JS template strings
  // inside it, so neither shell has nested quotes or literal user data to parse.
  const expression = shell.posix
    ? 'eval(Buffer.from(`' + encoded + '`,`base64`).toString())'
    : "eval(Buffer.from('" + encoded + "','base64').toString())"
  return `node -e ${shell.posix ? shellQuoteArg(expression) : expression}`
}
