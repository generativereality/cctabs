import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import type { Config } from '../types/index.js'

export const CONFIG_PATH = join(homedir(), '.config', 'cctabs', 'config.toml')

const DEFAULT_CONFIG: Config = {
  claude: { flags: ['--allow-dangerously-skip-permissions'] },
  defaults: { workspace: '', prefix: '' },
}

const DEFAULT_CONFIG_FILE = `# cctabs configuration
# https://cctabs.com

[claude]
# Extra flags passed to every \`claude\` invocation.
flags = ["--allow-dangerously-skip-permissions"]

[defaults]
# Default workspace to open new sessions in. Inert on Tabby, which has no
# workspace concept — kept for config compatibility.
# workspace = ""

# Prefix prepended to every new tab title AND \`claude --name\` (the claude.ai
# remote-control session name) minted by \`new\`/\`resume\`/\`fork\`. Use it to
# disambiguate this machine's sessions when several machines share one
# remote-control list, e.g. "mbp18-". Empty (no prefix) by default.
# prefix = ""
`

function parseToml(text: string): Partial<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {}
  let section: string | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).trim()
      result[section] ??= {}
      continue
    }

    if (section && line.includes('=')) {
      const [rawKey, ...rest] = line.split('=')
      const key = rawKey.trim()
      const val = rest.join('=').trim()

      if (val.startsWith('[')) {
        const items = [...val.matchAll(/"([^"]*)"/g)].map((m) => m[1])
        result[section][key] = items
      } else if (val.startsWith('"') && val.endsWith('"')) {
        result[section][key] = val.slice(1, -1)
      } else if (val === 'true' || val === 'false') {
        result[section][key] = val === 'true'
      }
    }
  }

  return result
}

export function loadConfig(): Config {
  const config: Config = {
    claude: { ...DEFAULT_CONFIG.claude },
    defaults: { ...DEFAULT_CONFIG.defaults },
  }

  if (!existsSync(CONFIG_PATH)) return config

  try {
    const parsed = parseToml(readFileSync(CONFIG_PATH, 'utf-8'))
    if (parsed.claude) Object.assign(config.claude, parsed.claude)
    if (parsed.defaults) Object.assign(config.defaults, parsed.defaults)
  } catch {
    // silently return defaults on parse error
  }

  return config
}

/**
 * Prepend the configured `prefix` to a freshly-minted tab/session name so the
 * Tabby title and the `claude --name` (→ claude.ai remote-control name) both
 * carry it. Idempotent: an empty prefix or a name that already starts with the
 * prefix is returned unchanged, so callers never double-prefix (and an
 * explicitly-typed full name like "mbp18-auth" stays as-is).
 */
export function applyPrefix(name: string, prefix: string): string {
  if (!prefix || name.startsWith(prefix)) return name
  return `${prefix}${name}`
}

export function ensureConfigExists(): string {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG_FILE)
  }
  return CONFIG_PATH
}
