// Build config for the cctabs Tabby plugin.
//
// Delegates to Tabby's own webpack.plugin.config.mjs so we get the same
// Angular AOT linker, source-map setup, and `externals` list every Tabby
// plugin uses. That file lives in the upstream Tabby repo — clone Tabby
// alongside this checkout under `related-repos/tabby` (or override with
// TABBY_REPO=/path) and run `yarn` in it once before building.

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
    `(or set TABBY_REPO) and run \`yarn\` in it before building this plugin.`,
  )
}

// Export an async config function so the `await import(...)` lives inside
// a function body — webpack-cli's sync require() can't handle top-level
// await in ESM config files.
export default async () => {
  const shared = (await import(url.pathToFileURL(sharedConfigPath).href)).default
  const config = shared({
    name: 'cctabs',
    dirname: __dirname,
  })

  // The shared config's resolve.modules list is rooted at our plugin's
  // dirname and includes `../node_modules` (which only works when the plugin
  // lives inside the Tabby workspace). Add Tabby's node_modules + the repo
  // root so peer-dep imports (`tabby-core`, `@angular/*`, etc.) and loader
  // modules (`@ngtools/webpack`, `babel-loader`, …) resolve correctly.
  const extraDirs = [
    path.join(tabbyRepo, 'node_modules'),
    path.join(tabbyRepo, 'app', 'node_modules'),
    tabbyRepo,
  ]
  config.resolve.modules = [...config.resolve.modules, ...extraDirs]
  config.resolveLoader = {
    ...(config.resolveLoader ?? {}),
    modules: [
      ...((config.resolveLoader && config.resolveLoader.modules) ?? ['node_modules']),
      ...extraDirs,
    ],
  }
  return config
}
