import { consola } from 'consola'
import type { TerminalAdapter } from './adapter.js'

/**
 * Capability token advertised by tabby-cctabs. Colour support is a
 * plugin-side feature, so it has to be probed: a plugin predating it ignores an
 * unknown `color` field on `POST /api/tabs/new` without complaint, and 404s the
 * `PUT /api/tabs/:uuid/color` route. Neither is distinguishable from "the colour
 * was applied and simply didn't render", so we ask first and say so when the
 * answer is no.
 */
export const CAP_TAB_COLOR = 'tab-color'

/**
 * Tabby's own tab palette, from `TAB_COLORS` in tabby-core/src/utils.ts.
 *
 * The hex values matter, not just the names: Tabby's right-click → Color menu
 * renders its radio state by comparing `tab.color === color.value` against
 * exactly these strings. Mapping "blue" to any other blue would colour the tab
 * correctly but leave that menu showing no selection — so a cctabs-set colour
 * would look subtly unlike a hand-set one. Keep these in step with upstream.
 */
export const TAB_COLORS: Record<string, string> = {
  blue: '#0275d8',
  green: '#5cb85c',
  orange: '#f0ad4e',
  purple: '#613d7c',
  red: '#d9534f',
  yellow: '#ffd500',
}

/** Names accepted by `--color`, in the order Tabby lists them, plus `none`. */
export const TAB_COLOR_NAMES = [...Object.keys(TAB_COLORS), 'none']

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * Turn a user-supplied `--color` value into what `BaseTabComponent.color`
 * wants: a CSS colour string, or `null` to clear the colour.
 *
 * Accepts a palette name (`blue`), a hex literal (`#0275d8`, `#08d`,
 * `#0275d8ff`), or `none` to clear. Anything else throws — Tabby applies the
 * value straight to a `[style.background-color]` binding, so an unrecognised
 * colour would just quietly fail to render, and a flag that does nothing is
 * worse than one that says why.
 */
export function resolveTabColor(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'none' || lower === 'no-color' || lower === 'default') return null
  if (TAB_COLORS[lower]) return TAB_COLORS[lower]
  if (HEX_RE.test(value)) return lower
  throw new Error(
    `Unknown color "${input}". Use one of ${TAB_COLOR_NAMES.join(', ')}, or a hex value like "#0275d8".`,
  )
}

/**
 * The colour a freshly-minted tab should get, in precedence order:
 *
 *   1. an explicit `--color`
 *   2. `[backends.<name>] color` for the preset being launched
 *   3. `[defaults] color`
 *
 * Returns `undefined` when no colour is configured at any level — distinct from
 * `null`, which is an explicit "clear it". Callers must not call the plugin at
 * all for `undefined`, or every uncoloured tab would cost a capability probe.
 */
export function resolveColorPreference(
  explicit: string | undefined,
  backendColor: string | undefined,
  defaultColor: string | undefined,
): string | null | undefined {
  const candidate = explicit || backendColor || defaultColor
  if (!candidate) return undefined
  return resolveTabColor(candidate)
}

let warnedUnsupported = false

/**
 * Whether the connected plugin can colour tabs, warning once per process when
 * it can't.
 *
 * Degrade, never fail: a user whose plugin is older than their CLI still wants
 * the tab — losing the spawn (and whatever was going to run in it) over a
 * cosmetic field is much the worse outcome. cctabs commands are one-shot, so a
 * module-level flag is enough to keep the warning to one line per invocation.
 */
export async function supportsTabColor(adapter: TerminalAdapter): Promise<boolean> {
  const caps = (await adapter.backendCapabilities?.()) ?? []
  if (caps.includes(CAP_TAB_COLOR)) return true
  if (!warnedUnsupported) {
    warnedUnsupported = true
    consola.warn(
      'This tabby-cctabs build cannot colour tabs — ignoring the requested colour. Update the plugin via Tabby → Settings → Plugins, then restart Tabby.',
    )
  }
  return false
}

/** Reset the warn-once latch. For tests, which run many cases in one process. */
export function resetTabColorWarning(): void {
  warnedUnsupported = false
}

/**
 * Colour an existing tab, no-op'ing (with one warning) against a plugin that
 * can't. Returns whether the colour was actually applied.
 */
export async function applyTabColor(
  adapter: TerminalAdapter,
  tabId: string,
  color: string | null,
): Promise<boolean> {
  if (!adapter.setTabColor) return false
  if (!(await supportsTabColor(adapter))) return false
  await adapter.setTabColor(tabId, color)
  return true
}
