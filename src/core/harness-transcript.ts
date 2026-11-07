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
 *   opencode  sessions live in its SQLite store; read through the tab's own
 *             opencode binary: `opencode session list --format json` (each
 *             with `directory`), then `opencode export <id>` on 1.x or
 *             `opencode session export <id>` on 2.x. 1.x and 2.x share the
 *             binary name, and 1.x cannot see 2.x's sessions, so the binary
 *             is the one the tab's process runs, not the first on PATH.
 *
 *   omp       oh-my-pi writes pi's JSONL format (a `session` line with `cwd` and
 *             `id`, then `message` lines) under `<sessions root>/<folder>/`, the
 *             root `--session-dir` from its argv, else `$PI_CODING_AGENT_DIR/sessions`
 *             or `~/.omp/agent/sessions`. The folder is named from the cwd
 *             relative to the temp folder (`-tmp-a-b`), else to home (`-a-b`),
 *             else the whole path (`--a-b--`) (src/session/session-paths.ts,
 *             18.18.0). It records no tab name, so the session is the file the
 *             tab's process holds open (lsof), else the one on `--resume`, else
 *             the newest whose `cwd` is the tab's folder. The open file comes
 *             first because omp forks a resumed session into a new file when
 *             another omp still has it open.
 *
 * Hermes and Grok Build are not read yet: they say so instead of guessing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { descendantsOf, type ProcRow } from './claude-procs.js'
import { HARNESS_BIN, HARNESS_LABEL, harnessOfCommand, type Harness } from './harness.js'
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
  matchedBy: 'name' | 'session-arg' | 'open-file' | 'newest-in-dir'
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

// ── oh-my-pi ─────────────────────────────────────────────────────────────────

export function ompSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (dir) return join(dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir, 'sessions')
  return join(homedir(), '.omp', 'agent', 'sessions')
}

/** `--session-dir DIR` or `--session-dir=DIR` on an omp command line. Pure. */
export function ompSessionDirArg(command: string): string | undefined {
  return command.match(/(?:^|\s)--session-dir(?:=|\s+)(\S+)/)?.[1]
}

/** `--resume ID`, `-r ID` or `--session ID` on an omp command line. Pure. */
export function ompResumeArg(command: string): string | undefined {
  return command.match(/(?:^|\s)(?:-r|--resume|--session)(?:=|\s+)([^\s-]\S*)/)?.[1]
}

/** The folder names omp may file a cwd's sessions under, most likely first. Pure. */
export function ompSessionDirNames(cwd: string, roots: { home: string; tmp: string }): string[] {
  const within = (root: string) => { const r = relative(root, cwd); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) ? r : undefined }
  const enc = (r: string) => r.replace(/[/\\:]/g, '-')
  const names: string[] = []
  const t = within(roots.tmp)
  if (t !== undefined) names.push(t ? `-tmp-${enc(t)}` : '-tmp')
  const h = within(roots.home)
  if (h !== undefined) names.push(h ? `-${enc(h)}` : '-')
  names.push(`--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  return names
}

/** The session `.jsonl` files a process holds open, from `lsof -Fn` output. Pure. */
export function ompOpenSessionFiles(lsofOutput: string): string[] {
  return lsofOutput.split('\n')
    .filter((l) => l.startsWith('n') && l.endsWith('.jsonl'))
    .map((l) => l.slice(1))
    .filter((f) => !/[/\\]\.[^/\\]*$/.test(f))
}

/** The session file an omp process is writing, when lsof can tell (macOS, Linux). */
export function ompOpenSessionFile(pid: number | undefined): string | undefined {
  if (!pid || process.platform === 'win32') return undefined
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    return ompOpenSessionFiles(out)[0]
  } catch (e) {
    const out = (e as { stdout?: string }).stdout
    return out ? ompOpenSessionFiles(out)[0] : undefined
  }
}

export function readOmpTranscript(cwd: string, command: string, sessionsRoot = ompSessionsRoot(), openFile?: string): HarnessTranscript | string {
  if (openFile && existsSync(openFile)) {
    const text = readFileSync(openFile, 'utf8')
    return { engine: 'omp', sessionId: piSessionMeta(text).id ?? openFile, source: openFile, matchedBy: 'open-file', turns: parsePiTurns(text) }
  }
  const real = (p: string) => { try { return realpathSync(p) } catch { return resolve(p) } }
  const cwds = [...new Set([resolve(cwd), real(cwd)])]
  const sessionDirArg = ompSessionDirArg(command)
  const dirs = sessionDirArg
    ? [resolve(cwd, sessionDirArg)]
    : [...new Set(cwds.flatMap((c) => [
        ...ompSessionDirNames(c, { home: homedir(), tmp: tmpdir() }),
        ...ompSessionDirNames(c, { home: real(homedir()), tmp: real(tmpdir()) }),
      ]))].map((n) => join(sessionsRoot, n))
  const files: { file: string; mtime: number }[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.jsonl')) files.push({ file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs })
  }
  if (!files.length) return `No oh-my-pi session for ${cwd} under ${sessionDirArg ?? sessionsRoot}.`
  files.sort((a, b) => b.mtime - a.mtime)
  const read = files.map((f) => ({ ...f, text: readFileSync(f.file, 'utf8') }))
  const headerCwd = (text: string) => {
    for (const line of text.split('\n').slice(0, 5)) { try { const e = JSON.parse(line); if (e.type === 'session') return e.cwd as string | undefined } catch { /* torn */ } }
    return undefined
  }
  const resumeId = ompResumeArg(command)
  const resumed = resumeId ? read.find((f) => (piSessionMeta(f.text).id ?? '').startsWith(resumeId) || f.file === resolve(cwd, resumeId)) : undefined
  const here = read.find((f) => { const c = headerCwd(f.text); return c !== undefined && (cwds.includes(c) || cwds.includes(real(c))) })
  const pick = resumed ?? here
  if (!pick) return `No oh-my-pi session for ${cwd} under ${sessionDirArg ?? sessionsRoot}.`
  return {
    engine: 'omp',
    sessionId: piSessionMeta(pick.text).id ?? pick.file,
    source: pick.file,
    matchedBy: resumed ? 'session-arg' : 'newest-in-dir',
    turns: parsePiTurns(pick.text),
  }
}

// ── opencode ─────────────────────────────────────────────────────────────────

/**
 * The assistant's text turns in an opencode export. Pure. Reads both shapes:
 * 1.x `opencode export` (`messages[].info.role`, `parts[]`) and 2.x
 * `opencode session export` (`messages[].type: assistant`, `content[]`).
 */
export function parseOpencodeExport(json: string): AssistantTurn[] {
  type Part = { type?: string; text?: string }
  const data = JSON.parse(json) as { messages?: { type?: string; info?: { role?: string; time?: { created?: number; completed?: number } }; time?: { created?: number; completed?: number }; parts?: Part[]; content?: Part[] }[] }
  const turns: AssistantTurn[] = []
  for (const m of data.messages ?? []) {
    if ((m.info?.role ?? m.type) !== 'assistant') continue
    const parts = m.parts ?? m.content ?? []
    const text = parts.filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text!).join('\n')
    const time = m.info?.time ?? m.time
    const at = time?.completed ?? time?.created
    if (text.trim()) turns.push({ text, timestamp: at ? new Date(at).toISOString() : undefined })
  }
  return turns
}

/** opencode's major version from `opencode --version` ("1.19.5", "opencode v2.2.6"). Pure. */
export function opencodeMajor(versionOutput: string): number | undefined {
  const m = versionOutput.match(/(\d+)\.\d+\.\d+/)
  return m ? Number(m[1]) : undefined
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
  // 1.x and 2.x share the binary name but not the commands: 2.x moved
  // `export` under `session`, and 1.x cannot see 2.x's sessions.
  let major: number | undefined
  try { major = opencodeMajor(run(['--version'])) } catch { /* try 1.x commands */ }
  const v2 = (major ?? 1) >= 2
  let sessions: { id: string; directory?: string; updated?: number }[]
  try { sessions = JSON.parse(run(['session', 'list', '--format', 'json'])) } catch (e) { return `\`opencode session list\` failed: ${(e as Error).message.split('\n')[0]}` }
  const pick = pickOpencodeSession(sessions, cwds, opencodeSessionArg(command))
  if (!pick) return `opencode has no session in ${cwd}.`
  const exportArgs = v2 ? ['session', 'export', pick.id] : ['export', pick.id]
  let turns: AssistantTurn[]
  try { turns = parseOpencodeExport(run(exportArgs)) } catch (e) { return `\`opencode ${exportArgs.join(' ')}\` failed: ${(e as Error).message.split('\n')[0]}` }
  return { engine: v2 ? 'opencode2' : 'opencode', sessionId: pick.id, source: `opencode ${exportArgs.join(' ')}`, matchedBy: pick.matchedBy, turns }
}

/** Read a harness tab's transcript, or say why not. `cwd` is the harness process's own folder (the caller reads it), falling back to the tab's. */
export function readHarnessTranscript(harness: Harness, cwd: string, tabName: string, proc: ProcRow, exe?: string): HarnessTranscript | string {
  if (harness === 'pi') return readPiTranscript(cwd || proc.cwd || '', tabName)
  if (harness === 'omp') return readOmpTranscript(cwd || proc.cwd || '', proc.command, ompSessionsRoot(), ompOpenSessionFile(proc.pid))
  if (harness === 'opencode' || harness === 'opencode2') return readOpencodeTranscript(cwd || proc.cwd || '', proc.command, exe || HARNESS_BIN[harness])
  return `cctabs cannot read ${HARNESS_LABEL[harness]} transcripts yet. Use \`cctabs scrollback\` for what is on its screen.`
}
