import { define } from 'gunshi'
import { consola } from 'consola'
import { listBackends } from '../core/backends.js'

export const backendsCommand = define({
  name: 'backends',
  description: 'List available Claude Code backend presets (Anthropic, Ollama Cloud, local Ollama)',
  args: {},
  async run() {
    consola.log('Available backends:\n')
    for (const b of listBackends()) {
      consola.log(`  ${b.name.padEnd(22)} ${b.description}`)
    }
    consola.log('\nUsage:  cctabs new <tab> <dir> --backend <name>')
    consola.log('Add custom presets in ~/.config/cctabs/config.toml under [backends.<name>].')
  },
})
