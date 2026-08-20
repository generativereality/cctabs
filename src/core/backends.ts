/**
 * Backend presets. Each preset resolves to a set of env vars (prepended to the
 * shell command in the new tab) plus a Claude --model name.
 *
 * The default `anthropic` preset is a no-op: no env vars, no --model override —
 * Claude Code uses its built-in API connection.
 *
 * Ollama-backed presets point ANTHROPIC_BASE_URL at Ollama's
 * Anthropic-compatible /v1/messages endpoint (Ollama ≥ 0.14):
 *   https://docs.ollama.com/openai
 *
 * The `*-tee` variants route through the local logging proxy on :11500
 * (`npm run ollama-tee` in the motin-scripts repo) for wire-level inspection.
 */

import { existsSync, readFileSync } from 'fs'
import { CONFIG_PATH } from './config.js'

export interface BackendSpec {
  /** Env vars to prepend to the `claude` command */
  env: Record<string, string>
  /** Value for `claude --model <name>` */
  model: string
  /** Human-friendly description shown in error messages */
  description?: string
  /**
   * Tab colour for sessions launched under this preset — a palette name or hex
   * value, as accepted by `--color`. This is what makes one account's tabs
   * visually distinct from another's when a fleet spans several Claude
   * profiles. Builtin presets set none; `[backends.<name>] color` supplies it.
   */
  color?: string
}

const OLLAMA_LOCAL = 'http://localhost:11434'
const OLLAMA_TEE = 'http://localhost:11500'

/**
 * For Ollama-backed Claude Code sessions we pin the small/fast/haiku model to
 * the same model. Otherwise Claude Code's background "haiku" calls 404 against
 * Ollama because the haiku tag doesn't exist there.
 */
function ollamaEnv(baseUrl: string, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'ollama',
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  }
}

const BUILTIN_BACKENDS: Record<string, BackendSpec> = {
  anthropic: {
    env: {},
    model: '',
    description: 'Default Anthropic API (no override)',
  },

  // --- Ollama Cloud (Pro tier required for these tags) ---
  kimi: {
    env: ollamaEnv(OLLAMA_LOCAL, 'kimi-k2.6:cloud'),
    model: 'kimi-k2.6:cloud',
    description: 'Kimi K2.6 via Ollama Cloud (Pro)',
  },
  'qwen-cloud': {
    env: ollamaEnv(OLLAMA_LOCAL, 'qwen3-coder-next:cloud'),
    model: 'qwen3-coder-next:cloud',
    description: 'Qwen3 Coder Next via Ollama Cloud',
  },
  'gemma-cloud': {
    env: ollamaEnv(OLLAMA_LOCAL, 'gemma4:31b-cloud'),
    model: 'gemma4:31b-cloud',
    description: 'Gemma4 31B via Ollama Cloud',
  },

  // --- Local Ollama (slow on M1 Max — ~100s/turn for 50k system prompt) ---
  'qwen-local': {
    env: ollamaEnv(OLLAMA_LOCAL, 'qwen3-coder:30b'),
    model: 'qwen3-coder:30b',
    description: 'Qwen3 Coder 30B local (18GB)',
  },
  'qwen-next-local': {
    env: ollamaEnv(OLLAMA_LOCAL, 'qwen3-coder-next:q3_K_M'),
    model: 'qwen3-coder-next:q3_K_M',
    description: 'Qwen3 Coder Next Q3_K_M local (38GB) — needs `ollama create` import',
  },
  'gpt-oss': {
    env: ollamaEnv(OLLAMA_LOCAL, 'gpt-oss:20b'),
    model: 'gpt-oss:20b',
    description: 'gpt-oss 20B local (13GB)',
  },
  llama: {
    env: ollamaEnv(OLLAMA_LOCAL, 'llama3.1:8b'),
    model: 'llama3.1:8b',
    description: 'Llama 3.1 8B local (5GB) — note: garbles on Claude Code\'s 50k system prompt',
  },
  'gemma-local': {
    env: ollamaEnv(OLLAMA_LOCAL, 'gemma4:26b'),
    model: 'gemma4:26b',
    description: 'Gemma4 26B local (17GB)',
  },

  // --- Tee proxy variants (route through localhost:11500 for logging) ---
  'kimi-tee': {
    env: ollamaEnv(OLLAMA_TEE, 'kimi-k2.6:cloud'),
    model: 'kimi-k2.6:cloud',
    description: 'Kimi via tee proxy (logs to /tmp/ollama-tee.log)',
  },
  'qwen-cloud-tee': {
    env: ollamaEnv(OLLAMA_TEE, 'qwen3-coder-next:cloud'),
    model: 'qwen3-coder-next:cloud',
    description: 'Qwen Cloud via tee proxy',
  },
  'qwen-next-local-tee': {
    env: ollamaEnv(OLLAMA_TEE, 'qwen3-coder-next:q3_K_M'),
    model: 'qwen3-coder-next:q3_K_M',
    description: 'Qwen Next local Q3 via tee proxy',
  },
}

/**
 * Parse a `[backends.<name>]` section from the config TOML. Each section can
 * override env vars and/or model. Format:
 *
 *   [backends.my-preset]
 *   model = "qwen3-coder-next:cloud"
 *   base_url = "http://localhost:11434"
 *   auth_token = "ollama"          # optional, defaults to "ollama" if base_url is set
 *   color = "blue"                 # optional, tab colour for this preset's tabs
 *
 * Or for full control:
 *
 *   [backends.my-preset]
 *   model = "..."
 *   env_ANTHROPIC_BASE_URL = "..."
 *   env_ANTHROPIC_AUTH_TOKEN = "..."
 */
function loadCustomBackends(): Record<string, BackendSpec> {
  if (!existsSync(CONFIG_PATH)) return {}

  const text = readFileSync(CONFIG_PATH, 'utf-8')
  const sections: Record<string, Record<string, string>> = {}
  let section: string | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim()
      sections[section] ??= {}
      continue
    }
    if (section?.startsWith('backends.') && line.includes('=')) {
      const [rawKey, ...rest] = line.split('=')
      const key = rawKey.trim()
      const val = rest.join('=').trim()
      if (val.startsWith('"') && val.endsWith('"')) {
        sections[section][key] = val.slice(1, -1)
      }
    }
  }

  const result: Record<string, BackendSpec> = {}
  for (const [section, kv] of Object.entries(sections)) {
    if (!section.startsWith('backends.')) continue
    const name = section.slice('backends.'.length)
    const model = kv.model ?? ''
    const env: Record<string, string> = {}

    if (kv.base_url) {
      const baseUrl = kv.base_url
      const token = kv.auth_token ?? 'ollama'
      Object.assign(env, {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        ANTHROPIC_API_KEY: '',
      })
      if (model) {
        env.ANTHROPIC_SMALL_FAST_MODEL = model
        env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model
      }
    }

    for (const [k, v] of Object.entries(kv)) {
      if (k.startsWith('env_')) env[k.slice(4)] = v
    }

    result[name] = {
      env,
      model,
      description: kv.description ?? `User-defined preset (${CONFIG_PATH})`,
      color: kv.color || undefined,
    }
  }

  return result
}

export function resolveBackend(name: string): BackendSpec | null {
  if (!name) return null
  const custom = loadCustomBackends()
  return custom[name] ?? BUILTIN_BACKENDS[name] ?? null
}

export function listBackends(): { name: string; description: string }[] {
  return listBackendSpecs().map(({ name, spec }) => ({
    name,
    description: spec.description ?? '',
  }))
}

/**
 * Every preset, builtin and user-defined, with its full spec. Session discovery
 * uses this to learn which Claude config directories exist on this machine: a
 * preset that sets `env_CLAUDE_CONFIG_DIR` puts its sessions somewhere other
 * than `~/.claude/projects`, and anything that only looks in the default
 * location simply cannot see them.
 */
export function listBackendSpecs(): Array<{ name: string; spec: BackendSpec }> {
  const merged = { ...BUILTIN_BACKENDS, ...loadCustomBackends() }
  return Object.entries(merged).map(([name, spec]) => ({ name, spec }))
}

/**
 * A tab launched with `-b <name>` gets CCTABS_ACTIVE_BACKEND=<name> injected
 * into its claude process's env alongside the preset's own vars. Because
 * `new`/`resume`/`fork` run as child processes of that claude process (they're
 * invoked from inside a running Claude Code session, e.g. via its Bash tool),
 * they inherit this var — which is how `--backend` can default to "whatever
 * backend the current session is running under" instead of always falling
 * back to plain `anthropic`. Distinct from CCTABS_BACKEND (terminal.ts), which
 * is an unrelated terminal-detection override alias for CCTABS_TERMINAL.
 */
export function resolveBackendName(explicit: string | undefined): string | undefined {
  return explicit || process.env.CCTABS_ACTIVE_BACKEND || undefined
}

/** Build the env map for a launch: the preset's own vars plus the marker above. */
export function backendEnvWithMarker(name: string, backend: BackendSpec): Record<string, string> {
  return { ...backend.env, CCTABS_ACTIVE_BACKEND: name }
}

/**
 * Env and model for relaunching a session that was discovered in a particular
 * Claude config directory.
 *
 * Resuming a session by id in the wrong config dir does not fail loudly — the
 * id simply isn't there, and you get a fresh conversation instead of the one
 * you asked for. So anything that relaunches a discovered session has to carry
 * its config dir along, whether or not a preset happens to name it:
 *
 *   - `backend` (a preset): use the preset's full env, so the account, base URL
 *     and model all come back too, not just the config dir.
 *   - `configDir` alone (a dir with no preset pointing at it): pass
 *     CLAUDE_CONFIG_DIR through directly, which is enough to find the session.
 */
export function launchEnvFor(
  backend?: string,
  configDir?: string,
): { env?: Record<string, string>; model?: string } {
  if (backend) {
    const spec = resolveBackend(backend)
    if (spec) {
      const env = backendEnvWithMarker(backend, spec)
      // Defensive: a preset that names no config dir still has to land in the
      // one the session was actually found in.
      if (configDir && !env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = configDir
      return { env, model: spec.model || undefined }
    }
  }
  if (configDir) return { env: { CLAUDE_CONFIG_DIR: configDir } }
  return {}
}
