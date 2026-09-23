import { existsSync, writeFileSync } from 'fs'
import { basename, dirname, resolve } from 'path'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import { collectSessionRows, type SessionRow } from '../core/session-rows.js'
import { liveSessionPids, ownClaudeProc, readProcessTable, type ProcRow } from '../core/claude-procs.js'
import { locateTranscriptFile } from '../core/transcript.js'
import { pathToProjectSlug } from '../core/session.js'
import { buildManifest, withoutInvalid, type ManifestEntry, type ManifestResult } from '../core/fleet-manifest.js'

export interface GatheredManifest {
  result: ManifestResult
  /** The process table it was built against, or null where there is no `ps`. */
  procRows: ProcRow[] | null
  /** Every tab row the manifest was built from, caller included. */
  rows: SessionRow[]
}

/** Read the live fleet and build a validated manifest from it. */
export async function gatherManifest(
  adapter: TerminalAdapter,
  opts: { includeSelf?: boolean; repointMissingDirs?: string },
): Promise<GatheredManifest> {
  const procRows = readProcessTable()
  const workspaces = await collectSessionRows(adapter, procRows)
  const rows = workspaces.flatMap((w) => w.sessions)
  const result = buildManifest(rows, {
    selfSessionId: process.env.CLAUDE_CODE_SESSION_ID || undefined,
    selfClaudePid: procRows ? ownClaudeProc(procRows)?.pid : undefined,
    includeSelf: opts.includeSelf,
    repointMissingDirs: opts.repointMissingDirs,
    dirExists: (p) => existsSync(p),
    transcriptExists: (id) => locateTranscriptFile(id) !== null,
    transcriptInDir: (id, dir) => {
      const located = locateTranscriptFile(id)
      return !!located && basename(dirname(located.file)) === pathToProjectSlug(dir)
    },
    liveSessionPids: procRows ? liveSessionPids(procRows) : new Map(),
  })
  return { result, procRows, rows }
}

/**
 * Print excluded rows and every problem, errors last so they're what stays on
 * screen. `consola.info` writes to stdout, which would corrupt a manifest being
 * piped from stdout — so the informational lines can be sent to stderr.
 */
export function reportManifest(result: ManifestResult, opts: { stdoutIsData?: boolean } = {}): void {
  const info = opts.stdoutIsData ? (m: string) => console.error(`ℹ ${m}`) : (m: string) => consola.info(m)
  for (const x of result.excluded) info(`Excluded ${x.name}: ${x.reason}`)
  for (const p of result.problems.filter((q) => q.severity === 'warning')) consola.warn(`${p.name}: ${p.message}`)
  for (const p of result.problems.filter((q) => q.severity === 'error')) consola.error(`${p.name}: ${p.message}`)
}

export function manifestJson(entries: ManifestEntry[]): string {
  return JSON.stringify({ generated_at: new Date().toISOString(), sessions: entries }, null, 2) + '\n'
}

export const manifestCommand = define({
  name: 'manifest',
  description: 'Snapshot the fleet as a validated restore manifest: keyed on session id, the calling session excluded, every dir and transcript checked.',
  args: {
    output: { type: 'string', short: 'o', description: 'Write the manifest here instead of stdout' },
    'repoint-missing-dirs': { type: 'string', description: 'Point entries whose directory no longer exists at this directory, instead of failing' },
    'include-self': { type: 'boolean', description: 'Keep the calling session in. Only for a manifest that will not drive a restart of this session.' },
    'drop-invalid': { type: 'boolean', description: 'Leave out entries with errors and emit the rest, instead of failing' },
  },
  async run(ctx) {
    const output = ctx.values.output as string | undefined
    const rawRepoint = ctx.values['repoint-missing-dirs'] as string | undefined
    const repoint = rawRepoint ? resolve(rawRepoint.replace(/^~/, homedir())) : undefined
    if (repoint && !existsSync(repoint)) {
      consola.error(`--repoint-missing-dirs ${repoint} does not exist either`)
      process.exit(1)
    }

    const adapter = requireAdapter()
    const { result, procRows } = await gatherManifest(adapter, {
      includeSelf: !!ctx.values['include-self'],
      repointMissingDirs: repoint,
    })
    adapter.closeSocket()

    if (!procRows) {
      consola.warn('No process table on this platform — ids come from transcripts only, and the calling session is excluded by session id alone.')
    }
    if (!process.env.CLAUDE_CODE_SESSION_ID && !ctx.values['include-self']) {
      consola.warn('CLAUDE_CODE_SESSION_ID is not set — not running inside Claude Code, so there is no calling session to exclude.')
    }

    reportManifest(result, { stdoutIsData: !output })
    const errors = result.problems.filter((p) => p.severity === 'error')
    if (errors.length && !ctx.values['drop-invalid']) {
      consola.error(`${errors.length} problem(s) — no manifest written. Fix them, or pass --drop-invalid to leave those entries out.`)
      process.exit(1)
    }

    const entries = ctx.values['drop-invalid'] ? withoutInvalid(result) : result.entries
    const json = manifestJson(entries)
    if (output) {
      writeFileSync(output, json)
      consola.success(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} → ${output}`)
    } else {
      process.stdout.write(json)
    }
  },
})
