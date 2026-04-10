import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import type { Config } from '../types/index.js'

export const CONFIG_PATH = join(homedir(), '.config', 'cctabs', 'config.toml')

const DEFAULT_CONFIG: Config = {
  claude: { flags: ['--allow-dangerously-skip-permissions'] },
  defaults: { workspace: '' },
}

const DEFAULT_CONFIG_FILE = `# cctabs configuration
# https://cctabs.com

[claude]
# Extra flags passed to every \`claude\` invocation.
flags = ["--allow-dangerously-skip-permissions"]

[defaults]
# Default Wave workspace to open new sessions in.
# workspace = ""
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

export function ensureConfigExists(): string {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG_FILE)
  }
  return CONFIG_PATH
}
