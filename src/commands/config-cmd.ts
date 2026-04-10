import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig, ensureConfigExists, CONFIG_PATH } from '../core/config.js'

export const configCommand = define({
  name: 'config',
  description: 'Show config file path and current values',
  args: {},
  async run() {
    ensureConfigExists()
    const config = loadConfig()

    consola.info(`Config: ${CONFIG_PATH}`)
    console.log()
    console.log(`claude.flags    = ${config.claude.flags.length ? JSON.stringify(config.claude.flags) : '(none)'}`)
    console.log(`defaults.workspace = ${config.defaults.workspace || '(none)'}`)
  },
})
