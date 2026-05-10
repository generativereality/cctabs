import { BaseTerminalTabComponent, XTermFrontend } from 'tabby-terminal'
import { SerializeAddon } from '@xterm/addon-serialize'

/**
 * Returns the serialized xterm buffer for a terminal tab. Re-uses an
 * already-loaded SerializeAddon if present, otherwise installs one.
 */
export function serializeBuffer (tab: BaseTerminalTabComponent<any>): string {
  const frontend = tab.frontend as XTermFrontend | undefined
  if (!frontend?.xterm) return ''

  const xterm: any = frontend.xterm
  let addon: SerializeAddon | undefined =
    xterm._addonManager?._addons?.find(
      (a: any) => a.instance instanceof SerializeAddon,
    )?.instance

  if (!addon) {
    addon = new SerializeAddon()
    xterm.loadAddon(addon)
  }
  return addon.serialize()
}

/** Strip ANSI escape sequences and split into lines. Optional last-N. */
export function bufferLines (text: string, lastN?: number): string[] {
  // Minimal ANSI strip — covers CSI and OSC sequences that xterm-addon-serialize emits
  const stripped = text
    .replace(/\][^]*(?:|\\)/g, '')  // OSC
    .replace(/\[[0-?]*[ -/]*[@-~]/g, '')               // CSI
    .replace(/[()][AB012]/g, '')                       // charset designators

  const lines = stripped.split(/\r?\n/)
  if (lastN && lines.length > lastN) return lines.slice(-lastN)
  return lines
}
