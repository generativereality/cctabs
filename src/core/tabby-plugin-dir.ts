import { homedir, platform } from 'os'
import { join } from 'path'

/**
 * Where Tabby loads plugins from, per platform.
 *
 * This lives in core rather than in the install command because `doctor` also
 * tells people the path, and the two used to disagree: doctor hardcoded the
 * macOS location in its hint string, so on Windows it printed
 * `$HOME/Library/Application Support/tabby/plugins` — a directory that cannot
 * exist there — while the install command's own `pluginsDir()` already knew the
 * right answer. One function, both callers.
 */
export function tabbyPluginsDir(): string {
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'tabby', 'plugins')
  }
  if (platform() === 'linux') {
    const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
    return join(xdg, 'tabby', 'plugins')
  }
  if (platform() === 'win32') {
    const app = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(app, 'tabby', 'plugins')
  }
  throw new Error(`unsupported platform: ${platform()}`)
}

/**
 * The by-hand install line for this platform, for when the automated path is
 * unavailable. `--legacy-peer-deps` is required: the plugin's peer deps
 * (`tabby-core`, `@angular/*`, …) live inside Tabby itself, not on npm.
 */
export function manualInstallSnippet(): string {
  const dir = tabbyPluginsDir()
  return platform() === 'win32'
    ? `npm install --legacy-peer-deps --prefix "${dir}" tabby-cctabs`
    : `npm install --legacy-peer-deps --prefix "${dir.replace(homedir(), '$HOME')}" tabby-cctabs`
}
