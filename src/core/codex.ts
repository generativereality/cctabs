/**
 * OpenAI's Codex CLI as the program in a tab, instead of Claude Code. Pure.
 *
 * Everything here was read off a real tab (Codex CLI 0.162.1, macOS, through
 * the plugin's `screen` endpoint, 2026-10-15) or taken from the codex-support
 * tab's measurements (~/Remember This/Notes/coordination/requests/
 * cctabs-codex-support-2026-10-15.md):
 *
 *   trust     Trust this folder? …                     shown first in a git folder,
 *             › 1. Trust and continue                  even with a prompt on argv;
 *               2. Back to Agent Command Center        the DEFAULT is trust (unlike
 *                                                      Claude, whose default exits)
 *   busy      • Working (2s • esc to interrupt)
 *   done      • ready
 *               Worked for 3s • 20:07
 *   ready     › Ask Codex to do anything               placeholder dim, like Claude's
 *             GPT-6.1-Sol default · <dir>
 *             ← for agents · ? for shortcuts
 */

export type Engine = 'claude' | 'codex'

export function parseEngine(v: string | undefined): Engine | null {
  if (v === undefined || v === '' || v === 'claude') return 'claude'
  if (v === 'codex') return 'codex'
  return null
}

const strip = (s: string) => s.replace(/\s+/g, '')

/**
 * The words after `codex` on the launch line. Pure.
 *
 * A prompt rides on argv — Codex runs it as the first turn — so nothing is
 * typed into the TUI and there is no paste to confirm. A repo that has a
 * CLAUDE.md and no AGENTS.md gets Codex to read the CLAUDE.md, which it
 * otherwise ignores (Codex reads AGENTS.md only).
 */
export function codexArgs(o: {
  prompt?: string
  resumeId?: string
  model?: string
  readClaudeMd?: boolean
  extraFlags?: string[]
}): string[] {
  const out: string[] = [...(o.extraFlags ?? [])]
  if (o.readClaudeMd) out.push('-c', 'project_doc_fallback_filenames=["CLAUDE.md"]')
  if (o.model) out.push('-m', o.model)
  if (o.resumeId) return ['resume', ...out, o.resumeId]
  if (o.prompt !== undefined) out.push(o.prompt)
  return out
}

/** Codex's folder-trust prompt is on screen, and which option the cursor is on. */
export function codexTrustDialog(screen: string): { visible: boolean; onTrust: boolean } {
  const c = strip(screen)
  if (!/Trustthisfolder\?/i.test(c) || !/Trustandcontinue/i.test(c)) return { visible: false, onTrust: false }
  return { visible: true, onTrust: /›1\.Trustandcontinue/.test(c) }
}

/** Codex is at its input, ready for text (not mid-turn, not in a dialog). */
export function codexReady(screen: string): boolean {
  const c = strip(screen)
  return /AskCodextodoanything/i.test(c) && !codexTrustDialog(screen).visible
}

/**
 * Codex's status from a captured buffer, or undefined when it isn't Codex.
 * The buffer is a log of redraws, so busy is "the last `• Working (` comes after
 * the last `Worked for`" — an earlier turn's busy line must not keep a finished
 * tab looking busy.
 */
export function codexStatus(buffer: string): 'active' | 'idle' | undefined {
  const c = strip(buffer)
  if (!/OpenAICodex|AskCodextodoanything|Workedfor\d+[hms]•/.test(c)) return undefined
  const busyAt = c.lastIndexOf('•Working(')
  const busy = busyAt >= 0 && busyAt > c.lastIndexOf('Workedfor') && /esctointerrupt/.test(c.slice(busyAt))
  return busy ? 'active' : 'idle'
}

/**
 * Is this command line a Codex TUI (not the shell that launched it, and not
 * Codex's shared `app-server` daemon)? The npm install runs as
 * `node /opt/homebrew/bin/codex …`, which starts a native `…/bin/codex …`.
 */
export function isCodexCommand(command: string): boolean {
  const words = command.split(/\s+/)
  const base = (w: string | undefined) => (w ?? '').split(/[\\/]/).pop() ?? ''
  const isCodex = (w: string | undefined) => /^codex(\.exe)?$/i.test(base(w))
  const codexAt = isCodex(words[0]) ? 0 : /^node(\.exe)?$/i.test(base(words[0])) && isCodex(words[1]) ? 1 : -1
  if (codexAt < 0) return false
  return words[codexAt + 1] !== 'app-server'
}
