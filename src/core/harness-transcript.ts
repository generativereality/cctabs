/**
 * `cctabs transcript` for tabs running another harness (`cctabs new --engine`):
 * find which harness the tab's shell is running, then read what it has said
 * from that harness's own session store.
 *
 *   pi        one JSONL file per session under `<agent dir>/sessions/--<cwd>--/`,
 *             agent dir `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, the cwd encoded
 *             as pi's session-manager does (leading separator dropped, `/ \ :`
 *             to `-`). Line 1 is the session header (`cwd`, `id`); a
 *             `session_info` line carries the `--name` cctabs launched it with.
 *             Assistant turns are `type: message`, `message.role: assistant`.
 *   opencode  sessions live in its SQLite store; read through its own CLI,
 *             `opencode session list --format json` (each with `directory`)
 *             and `opencode export <id>` (`messages[].info.role`, `parts[]`
 *             of `type: text`). 1.x and 2.x share the binary.
 *
 * Hermes and Grok Build are not read yet: they say so instead of guessing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { descendantsOf, type ProcRow } from './claude-procs.js'
import { HARNESS_LABEL, harnessOfCommand, type Harness } from './harness.js'
import type { AssistantTurn } from './transcript.js'

/** The harness running under a tab's shell, nearest first. Pure. */
export function harnessInShell(shellPid: number | undefined, rows: ProcRow[]): { harness: Harness; proc: ProcRow } | undefined {
  if (!shellPid) return undefined
  for (const proc of descendantsOf(shellPid, rows)) {
    const harness = harnessOfCommand(proc.command)
    if (harness) return { harness, proc }
  }
  return undefined
}

export interface HarnessTranscript {
  engine: Harness
  sessionId: string
  /** Where it was read from: a file, or the harness command that printed it. */
  source: string
  /** How the session was chosen, so a guess is never shown as a certainty. */
  matchedBy: 'name' | 'session-arg' | 'newest-in-dir'
  turns: AssistantTurn[]
}

// ── pi ───────────────────────────────────────────────────────────────────────

export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (dir) return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir
  return join(homedir(), '.pi', 'agent')
}

/** pi's folder name for a cwd. Pure. */
export function piSessionDirName(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
}

/** The assistant's text turns in a pi session file. Pure. */
export function parsePiTurns(jsonl: string): AssistantTurn[] {
  const turns: AssistantTurn[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let e: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } }
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'message' || e.message?.role !== 'assistant') continue
    const content = e.message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('\n')
        : ''
    if (text.trim()) turns.push({ text, timestamp: e.timestamp })
  }
  return turns
}

/** A pi session's id and the name it was given (the last `session_info` wins). Pure. */
export function piSessionMeta(jsonl: string): { id?: string; name?: string } {
  let id: string | undefined, name: string | undefined
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"session')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'session' && typeof e.id === 'string') id = e.id
      if (e.type === 'session_info' && typeof e.name === 'string') name = e.name
    } catch { /* a torn last line while pi writes */ }
  }
  return { id, name }
}

export function readPiTranscript(cwd: string, tabName: string, agentDir = piAgentDir()): HarnessTranscript | string {
  const cwds = [resolve(cwd)]
  try { const real = realpathSync(cwd); if (!cwds.includes(real)) cwds.push(real) } catch { /* gone */ }
  const files: { file: string; mtime: number }[] = []
  for (const c of cwds) {
    const dir = join(agentDir, 'sessions', piSessionDirName(c))
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.push({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
  }
  if (!files.length) return `No pi session for ${cwd} under ${join(agentDir, 'sessions')}.`
  files.sort((a, b) => b.mtime - a.mtime)
  const read = files.map((f) => ({ ...f, text: readFileSync(f.file, 'utf8') }))
  const named = read.find((f) => piSessionMeta(f.text).name === tabName)
  const pick = named ?? read[0]
  const meta = piSessionMeta(pick.text)
  return {
    engine: 'pi',
    sessionId: meta.id ?? pick.file,
    source: pick.file,
    matchedBy: named ? 'name' : 'newest-in-dir',
    turns: parsePiTurns(pick.text),
  }
}

// ── opencode ─────────────────────────────────────────────────────────────────

/** The assistant's text turns in `opencode export` output. Pure. */
export function parseOpencodeExport(json: string): AssistantTurn[] {
  const data = JSON.parse(json) as { messages?: { info?: { role?: string; time?: { created?: number; completed?: number } }; parts?: { type?: string; text?: string }[] }[] }
  const turns: AssistantTurn[] = []
  for (const m of data.messages ?? []) {
    if (m.info?.role !== 'assistant') continue
    const text = (m.parts ?? []).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text!).join('\n')
    const at = m.info.time?.completed ?? m.info.time?.created
    if (text.trim()) turns.push({ text, timestamp: at ? new Date(at).toISOString() : undefined })
  }
  return turns
}

/** The session a tab's opencode is on: `--session` on its argv, else the newest in its folder. Pure. */
export function pickOpencodeSession(
  sessions: { id: string; directory?: string; updated?: number }[],
  cwds: string[],
  argvSession?: string,
): { id: string; matchedBy: 'session-arg' | 'newest-in-dir' } | undefined {
  if (argvSession && sessions.some((s) => s.id === argvSession)) return { id: argvSession, matchedBy: 'session-arg' }
  const here = sessions.filter((s) => s.directory && cwds.includes(s.directory)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
  return here[0] ? { id: here[0].id, matchedBy: 'newest-in-dir' } : undefined
}

/** `-s ID`, `--session ID` or `--session=ID` on an opencode command line. Pure. */
export function opencodeSessionArg(command: string): string | undefined {
  return command.match(/(?:^|\s)(?:-s|--session)(?:=|\s+)(\S+)/)?.[1]
}

export function readOpencodeTranscript(cwd: string, command: string, bin = 'opencode'): HarnessTranscript | string {
  const cwds = [resolve(cwd)]
  try { const real = realpathSync(cwd); if (!cwds.includes(real)) cwds.push(real) } catch { /* gone */ }
  const run = (args: string[]) => execFileSync(bin, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
    // npm installs opencode as opencode.cmd on Windows, which needs a shell to run.
    shell: process.platform === 'win32',
  })
  let sessions: { id: string; directory?: string; updated?: number }[]
  try { sessions = JSON.parse(run(['session', 'list', '--format', 'json'])) } catch (e) { return `\`opencode session list\` failed: ${(e as Error).message.split('\n')[0]}` }
  const pick = pickOpencodeSession(sessions, cwds, opencodeSessionArg(command))
  if (!pick) return `opencode has no session in ${cwd}.`
  let turns: AssistantTurn[]
  try { turns = parseOpencodeExport(run(['export', pick.id])) } catch (e) { return `\`opencode export ${pick.id}\` failed: ${(e as Error).message.split('\n')[0]}` }
  return { engine: 'opencode', sessionId: pick.id, source: `opencode export ${pick.id}`, matchedBy: pick.matchedBy, turns }
}

/** Read a harness tab's transcript, or say why not. */
export function readHarnessTranscript(harness: Harness, cwd: string, tabName: string, proc: ProcRow): HarnessTranscript | string {
  if (harness === 'pi') return readPiTranscript(proc.cwd || cwd, tabName)
  if (harness === 'opencode' || harness === 'opencode2') return readOpencodeTranscript(proc.cwd || cwd, proc.command)
  return `cctabs cannot read ${HARNESS_LABEL[harness]} transcripts yet. Use \`cctabs scrollback\` for what is on its screen.`
}
