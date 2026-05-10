// Build config for the cctabs Tabby plugin.
//
// We delegate to Tabby's own `webpack.plugin.config.mjs` so we get the same
// Angular AOT linker, source-map setup, and `externals` list every other Tabby
// plugin uses. That file is not published to npm — it lives in the upstream
// Tabby repo. To build, clone Tabby alongside this checkout (we use
// `../related-repos/tabby` by convention) and run `yarn` in it once.
//
// Override the path with TABBY_REPO=/path/to/tabby if you keep your clone
// elsewhere.

import * as path from 'path'
import * as url from 'url'
import { existsSync } from 'fs'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const tabbyRepo = process.env.TABBY_REPO
  ?? path.resolve(__dirname, '..', 'related-repos', 'tabby')

const sharedConfigPath = path.join(tabbyRepo, 'webpack.plugin.config.mjs')
if (!existsSync(sharedConfigPath)) {
  throw new Error(
    `Tabby plugin webpack config not found at ${sharedConfigPath}.\n` +
    `Clone Tabby (https://github.com/Eugeny/tabby) into related-repos/tabby ` +
    `(or set TABBY_REPO) and run \`yarn\` in it before building this plugin.`
  )
}

const sharedConfig = (await import(url.pathToFileURL(sharedConfigPath).href)).default

export default () => sharedConfig({
  name: 'cctabs',
  dirname: __dirname,
})
