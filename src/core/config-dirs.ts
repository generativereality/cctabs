import { homedir } from 'os'
import { join, resolve } from 'path'
import { listBackendSpecs } from './backends.js'

/**
 * Where Claude Code keeps its session transcripts.
 *
 * There is more than one such place on a machine that uses several Claude
 * accounts: a backend preset can set `CLAUDE_CONFIG_DIR`, and every session
 * launched under that preset lives in *its* projects directory, invisible to
 * anything that only looks in `~/.claude/projects`. That invisibility is not a
 * cosmetic problem — a tab whose session can't be found can't be restored, and
 * a session id resumed against the wrong config dir silently opens a fresh
 * conversation instead of failing.
 *
 * So discovery searches every config dir cctabs knows about, and reports which
 * one each session came from. That mapping is also how the backend is inferred:
 * a session found in gapminder's config dir is a gapminder-backend session, no
 * extra bookkeeping required.
 */
export interface ClaudeConfigDir {
  /** The directory CLAUDE_CONFIG_DIR points at, e.g. ~/.claude-gapminder. */
  root: string
  /** Where transcripts live: <root>/projects. */
  projectsRoot: string
  /** Preset that selects this dir. Undefined for the default dir. */
  backend?: string
}

/** The config dir Claude uses when nothing overrides it. */
export const DEFAULT_CONFIG_ROOT = join(homedir(), '.claude')

function expandTilde(p: string): string {
  return resolve(p.replace(/^~(?=$|\/)/, homedir()))
}

function makeDir(root: string, backend?: string): ClaudeConfigDir {
  return { root, projectsRoot: join(root, 'projects'), backend }
}

let cached: ClaudeConfigDir[] | null = null

/**
 * Every Claude config dir on this machine: the default one first, then one per
 * backend preset that names its own, then whatever this process happens to be
 * running under (so a session started with an ad-hoc `CLAUDE_CONFIG_DIR` and no
 * preset is still discoverable).
 *
 * Deduped by resolved path, first mention winning — a preset pointing at the
 * default dir doesn't turn default-dir sessions into backend sessions.
 * Cached: cctabs commands are one-shot, so config can't change underneath us.
 */
export function listClaudeConfigDirs(): ClaudeConfigDir[] {
  if (cached) return cached

  const byPath = new Map<string, ClaudeConfigDir>()
  const add = (root: string, backend?: string) => {
    const key = expandTilde(root)
    if (!byPath.has(key)) byPath.set(key, makeDir(key, backend))
  }

  add(DEFAULT_CONFIG_ROOT)
  for (const { name, spec } of listBackendSpecs()) {
    const dir = spec.env.CLAUDE_CONFIG_DIR
    if (dir) add(dir, name)
  }
  if (process.env.CLAUDE_CONFIG_DIR) add(process.env.CLAUDE_CONFIG_DIR)

  cached = [...byPath.values()]
  return cached
}

/** Drop the cache. For tests, which reconfigure the environment between cases. */
export function resetClaudeConfigDirsCache(): void {
  cached = null
}

/**
 * Normalise a discovery function's root argument.
 *
 * Callers (and tests) may pin the search to a single projects directory or to
 * an explicit list of config dirs; passing nothing searches every config dir
 * this machine knows about.
 */
export type ConfigDirScope = string | ClaudeConfigDir[] | undefined

export function scopeToDirs(scope: ConfigDirScope): ClaudeConfigDir[] {
  if (Array.isArray(scope)) return scope
  if (typeof scope === 'string') {
    // A bare projects root, e.g. "<tmp>/projects" — its parent is the config dir.
    return [{ root: resolve(scope, '..'), projectsRoot: scope }]
  }
  return listClaudeConfigDirs()
}

/**
 * How a session should be relaunched, given where it was found. Both fields are
 * absent for the default config dir, which needs no env at all.
 */
export interface SessionOrigin {
  /** Preset naming this config dir, when one does. */
  backend?: string
  /** The config dir itself, when it isn't the default one. */
  configDir?: string
}

export function originOf(dir: ClaudeConfigDir): SessionOrigin {
  if (dir.root === DEFAULT_CONFIG_ROOT && !dir.backend) return {}
  return { backend: dir.backend, configDir: dir.root }
}
