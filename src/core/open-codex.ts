import { existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { consola } from 'consola'
import { requireAdapter } from './adapter.js'
import { loadConfig } from './config.js'
import { resolveTabShell, tabLaunchArgv, shellQuoteArg } from './shell.js'
import { readTab } from './open-session.js'
import { codexArgs, codexReady, codexStatus, codexTrustDialog } from './codex.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface OpenCodexOptions {
  tabName: string
  dir: string
  /** The first turn. Passed on argv: Codex runs it at once, nothing is typed. */
  prompt?: string
  resumeId?: string
  model?: string
  afterActive?: boolean
  color?: string | null
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
  const dir = resolve(opts.dir.replace(/^~/, homedir()))
  if (!existsSync(dir)) throw new Error(`Directory does not exist: ${dir}`)
  const adapter = requireAdapter()
  if (!adapter.openTabDirect) throw new Error('Codex tabs need the Tabby plugin.')

  const shell = resolveTabShell()

  const readClaudeMd = existsSync(join(dir, 'CLAUDE.md')) && !existsSync(join(dir, 'AGENTS.md'))
  const body = codexLaunchBody({ ...opts, readClaudeMd }, shell)

  const { blockId, tabId } = await adapter.openTabDirect({
    cwd: dir,
    title: opts.tabName,
    command: shell.command,
    args: tabLaunchArgv(shell, body),
    afterActive: opts.afterActive,
    color: opts.color,
  })
  if (readClaudeMd) consola.info('This folder has a CLAUDE.md and no AGENTS.md, so Codex is told to read CLAUDE.md.')

  // Get past the trust prompt, then confirm Codex is up.
  const deadline = Date.now() + 45_000
  let answered = false
  while (Date.now() < deadline) {
    await sleep(700)
    const screen = await readTab(adapter, blockId, 40)
    const trust = codexTrustDialog(screen)
    if (trust.visible) {
      if (answered) continue
      if (!trust.onTrust) {
        consola.warn('Codex is asking whether to trust this folder, and the cursor is not on "Trust and continue". Left for you to answer in the tab.')
        return tabId
      }
      await sleep(400) // let the dialog's key handler attach
      await adapter.sendInput(blockId, '\r')
      answered = true
      continue
    }
    if (codexReady(screen) || codexStatus(screen) === 'active') return tabId
  }
  consola.warn('Could not confirm Codex started within 45s — check the tab. (Signed out? `codex login`.)')
  return tabId
}

/**
 * cmd expands %, ! and metacharacters even inside several quoting forms.
 * Keep all user argv out of its parser: an encoded Node bootstrap invokes the
 * npm Codex JS entry directly with an argv array and shell:false. The fixed
 * bootstrap token contains only base64 characters; newlines stay in JSON.
 */
export function codexLaunchBody(opts: Parameters<typeof codexArgs>[0] & { cwd?: string }, shell: { posix: boolean }): string {
  const args = codexArgs({ extraFlags: loadConfig().codex.flags, ...opts })
  if (shell.posix) return ['codex', ...args.map(shellQuoteArg)].join(' ')
  const script = `${opts.cwd ? `process.chdir(${JSON.stringify(opts.cwd)});` : ''}const {spawnSync}=require('node:child_process');const {join,dirname}=require('node:path');const {existsSync}=require('node:fs');const r=spawnSync('where.exe',['codex.cmd'],{encoding:'utf8'});const shim=(r.stdout||'').split(/\\r?\\n/).find(p=>p.trim());const entry=shim&&join(dirname(shim.trim()),'node_modules','@openai','codex','bin','codex.js');if(!entry||!existsSync(entry)){console.error('Install Codex with npm i -g @openai/codex');process.exit(1)}const child=spawnSync(process.execPath,[entry,...${JSON.stringify(args)}],{stdio:'inherit',shell:false});process.exit(child.status??1);`
  return `node -e "eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())"`
}
