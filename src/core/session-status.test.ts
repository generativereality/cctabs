import { describe, expect, it } from 'bun:test'
import {
  autoModeDialogVisible,
  classifyTerminalBuffer,
  parsePermissionMode,
  promptIsReady,
  toLaunchableMode,
  trustDialogVisible,
} from './session-status.js'

/**
 * Fixtures are trimmed captures from a real 59-tab fleet, taken through the
 * Tabby plugin's own `/api/tabs/:id/buffer` endpoint — including its habit of
 * dropping the spaces between adjacent characters.
 */

/** A long-context session sitting at an empty prompt. This is what idle looks like. */
const IDLE_TAIL = `
⏵⏵automodeon (shift+tabtocycle)·←foragents
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
`

/** Mid-turn: spinner glyphs and an elapsed-time label dominate the tail. */
const BUSY_TAIL = `
⏺Bash(cd /tmp&&python3-<<'EOF' import json,…)  ⎿  Running…
✽ Dilly-dallying… (14m 5s · ↓34.9k tokens)
~/Dev/Projects/generativereality/cctabs|Opus5(1Mcontext)|ctx:11%|5h:2%7d:42%/rc
⏵⏵bypasspermissionson ·1shell ·←foragents
Dilly-dallying…
✻Dilly-dallying…
`

/** The turn just ended. A glyph is present but the session is waiting again. */
const JUST_FINISHED_TAIL = `
Ithendidtheotherthing.
✻Bakedfor47s
※recap:Goalwascheckingwhethercctabssortworks
`

describe('classifyTerminalBuffer', () => {
  it('reports an empty capture as unreadable, never as a bare terminal', () => {
    expect(classifyTerminalBuffer('')).toBe('unreadable')
    expect(classifyTerminalBuffer('   \n\n  \n')).toBe('unreadable')
  })

  it('reports a session at its prompt as idle, not active', () => {
    expect(classifyTerminalBuffer(IDLE_TAIL)).toBe('idle')
  })

  it('reports a session with a turn in flight as active', () => {
    expect(classifyTerminalBuffer(BUSY_TAIL)).toBe('active')
  })

  it('does not call a just-finished turn active — a completion notice carries a spinner glyph too', () => {
    expect(classifyTerminalBuffer(JUST_FINISHED_TAIL)).toBe('idle')
  })

  it('recognises a completion notice by its shape, not by its verb', () => {
    // Claude's verb vocabulary is open-ended: an enumerated list shipped here
    // and missed `Sautéed for` on the first real fleet it was run against.
    for (const verb of ['Sautéed', 'Baked', 'Worked', 'Effervescing', 'Whatever']) {
      expect(classifyTerminalBuffer(`✻${verb} for 4m 1s`)).toBe('idle')
    }
  })

  it('still calls a spinner with an elapsed-time readout active', () => {
    // The in-flight line carries a duration too — but never the word "for".
    expect(classifyTerminalBuffer('✽ Dilly-dallying… (14m 5s · ↓34.9k tokens)')).toBe('active')
  })

  it('does not treat permanent chrome as evidence of work in flight', () => {
    // Every one of these is on screen for the life of a session. Matching any
    // of them as "active" is what collapsed the whole fleet into one state.
    for (const chrome of [
      'Claude Code v2.0',
      'https://claude.ai/code',
      '⏵⏵ bypass permissions on',
      '⏵⏵ auto mode on (shift+tab to cycle)',
      'new task? /clear to save 304.6k tokens',
      'Checking for updates',
    ]) {
      expect(classifyTerminalBuffer(chrome)).toBe('idle')
    }
  })

  it('reports a bare shell as terminal even while Claude UI lingers in the buffer', () => {
    // The buffer keeps everything the tab ever emitted, so a session that has
    // exited leaves its chrome behind. The live prompt is what counts.
    const exited = `${IDLE_TAIL}\nmotin@mbp cctabs %`
    expect(classifyTerminalBuffer(exited)).toBe('terminal')
  })

  it('ignores a stale spinner far above the live tail', () => {
    // The buffer accumulates; it is not a viewport. A glyph 40 redraws ago
    // proves the session was busy then, not now.
    const stale = `✻ Thinking…\n⏵⏵ auto mode on\n${'/rc\n'.repeat(40)}`
    expect(classifyTerminalBuffer(stale)).toBe('idle')
  })

  it('matches markers through the plugin dropping spaces between characters', () => {
    expect(classifyTerminalBuffer('⏵⏵automodeon (shift+tabtocycle)')).toBe('idle')
  })
})

describe('parsePermissionMode', () => {
  // Footer text as the plugin's buffer actually delivers it, spaces and all.
  const PILLS: Array<[string, string]> = [
    ['⏵⏵automodeon (shift+tabtocycle)·←foragents', 'auto'],
    ['⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', 'acceptEdits'],
    ['⏸ plan mode on (shift+tab to cycle) · ← for agents', 'plan'],
    ['⏵⏵bypasspermissionson ·1shell ·←foragents', 'bypassPermissions'],
    ['⏸ manual mode on · ← for agents', 'manual'],
  ]

  for (const [pill, expected] of PILLS) {
    it(`reads ${expected} from its footer`, () => {
      expect(parsePermissionMode(pill)).toBe(expected as never)
    })
  }

  it('takes the most recent pill, since the buffer keeps every redraw', () => {
    // Cycling shift+tab leaves the old pills above the new one.
    const cycled = [
      '⏵⏵ auto mode on',
      '⏸ manual mode on',
      '⏸ plan mode on',
    ].join('\n')
    expect(parsePermissionMode(cycled)).toBe('plan')
  })

  it('returns nothing when there is no footer to read', () => {
    expect(parsePermissionMode('')).toBeUndefined()
    expect(parsePermissionMode('motin@mbp cctabs %')).toBeUndefined()
  })
})

describe('toLaunchableMode', () => {
  it('accepts every mode claude --permission-mode takes', () => {
    for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'plan']) {
      expect(toLaunchableMode(m)).toBe(m as never)
    }
  })

  it('drops "default", which real transcripts contain and the flag rejects', () => {
    // Passing it through would make the relaunch fail outright rather than
    // fall back to the configured flags.
    expect(toLaunchableMode('default')).toBeUndefined()
  })

  it('drops anything else, including non-strings', () => {
    for (const v of ['dontAsk', 'PLAN', '', undefined, null, 7, {}]) {
      expect(toLaunchableMode(v)).toBeUndefined()
    }
  })
})

/**
 * Verbatim captures of the two dialogs that stranded 10 tabs of a 65-tab
 * restore, taken through the plugin's buffer endpoint — spaces dropped between
 * adjacent glyphs exactly as it delivers them.
 */
const TRUST_DIALOG = `
──────────────────────────────────────────
Accessingworkspace:
/Users/motin/Dev/Projects/generativereality/cctabs
Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensourceproject,orworkfromyourteam).Ifnot,takeamomenttoreview
what'sinthisfolderfirst.
ClaudeCode'llbeabletoread,edit,andexecutefileshere.
Securityguide
❯1.Yes,Itrustthisfolder
2.No,exit
Entertoconfirm·Esctocancel
`

const AUTO_MODE_DIALOG = `
Setupautomodeforyourenvironment?
Automodelets Claudeactwithoutaskingfirst.Tellingitwhichreposyoutrustandwhatdataissensitivegivesitclearerguardrailsonwhat'ssafetorun.
❯1.Setitup
2.Notnow
3.Don'tshowagain
Entertoconfirm·Esctocancel
`

const LIVE_FOOTER = `
~/RememberThis|Opus5(1Mcontext)|ctx:56%
⏵⏵automodeon (shift+tabtocycle)·←foragents
`

describe('trustDialogVisible', () => {
  it('sees the dialog that stranded 8 tabs of a real restore', () => {
    expect(trustDialogVisible(TRUST_DIALOG)).toBe(true)
  })

  it('is not fooled by a live session, whose footer also says "auto mode"', () => {
    expect(trustDialogVisible(LIVE_FOOTER)).toBe(false)
    expect(trustDialogVisible('')).toBe(false)
  })

  it('does not confuse the two dialogs', () => {
    expect(trustDialogVisible(AUTO_MODE_DIALOG)).toBe(false)
  })
})

describe('autoModeDialogVisible', () => {
  it('sees the dialog whose DEFAULT option is the wrong one', () => {
    expect(autoModeDialogVisible(AUTO_MODE_DIALOG)).toBe(true)
  })

  it('matches on the options alone, since the prose wraps at terminal width', () => {
    expect(autoModeDialogVisible('❯1.Setitup\n2.Notnow\n3.Don\'tshowagain')).toBe(true)
  })

  it('does not fire on a live session or on the trust dialog', () => {
    // "auto mode on" in the footer must never read as the setup dialog — that
    // would send a stray ↓+Enter into a working session's input box.
    expect(autoModeDialogVisible(LIVE_FOOTER)).toBe(false)
    expect(autoModeDialogVisible(TRUST_DIALOG)).toBe(false)
    expect(autoModeDialogVisible('')).toBe(false)
  })
})

describe('promptIsReady', () => {
  it('accepts a bare shell prompt', () => {
    expect(promptIsReady('~/Dev/cctabs %')).toBe(true)
    expect(promptIsReady('user@host:~$')).toBe(true)
  })

  it("accepts Claude's input line with its placeholder", () => {
    expect(promptIsReady('❯ Try "fix the failing test"')).toBe(true)
  })

  it("accepts Claude's input footer", () => {
    expect(promptIsReady('  ⏵⏵ auto mode on   shift+tab to cycle')).toBe(true)
  })

  // The measured false negative: --wait-for-prompt timed out at 20s against
  // tabs whose prompts were ready, because Claude renders this notice BELOW
  // the input line and only the last line was being tested.
  it('sees a ready prompt underneath a "Restart to update" banner', () => {
    const buffer = [
      '❯ Try "fix the failing test"',
      '',
      '  Restart to update to v2.1.4',
    ].join('\n')
    expect(promptIsReady(buffer)).toBe(true)
  })

  it('is false for an empty buffer', () => {
    expect(promptIsReady('')).toBe(false)
    expect(promptIsReady('   \n  ')).toBe(false)
  })

  it('is false for a tab showing no prompt at all', () => {
    expect(promptIsReady('✽ Dilly-dallying… (14m 5s · ↓34.9k tokens)')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Suspended tabs and the startup dialogs a wake has to get through.

import {
  claudeInputReady,
  isSuspended,
  mcpApprovalDialogVisible,
  suspendMarkerShowing,
  trustDialogState,
} from './session-status.js'

/** Current Claude Code: "No, exit" is option 1 AND highlighted. Bare Enter quits. */
const TRUST_NO_FIRST = `
Quick safety check: Is this a project you created or one you trust?
❯ 1. No, exit
  2. Yes, I trust this folder
Enter to confirm · Esc to cancel
`

/** Older builds: Yes first and highlighted. */
const TRUST_YES_FIRST = `
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
  2. No, exit
`

/** Captured live, 2026-09-23, through the plugin's buffer endpoint: unnumbered. */
const TRUST_LIVE_UNNUMBERED = `
Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?(Likeyourowncode,awell-knownopensourceproject,orworkfromyourteam).Ifnot,takeamomentto
reviewwhat'sinthisfolderfirst.

ClaudeCode'llbeabletoread,edit,andexecutefileshere.

Securityguide

❯No,exit
Yes,Itrustthisfolder

Entertoconfirm·Esctocancel
`

describe('trustDialogState', () => {
  it('reads the live, UNNUMBERED layout: Yes is second, the cursor is on "No, exit"', () => {
    expect(trustDialogState(TRUST_LIVE_UNNUMBERED)).toEqual({ yes: 2, no: 1, cursor: 1 })
  })

  it('follows the cursor onto Yes in the unnumbered layout after a ↓', () => {
    expect(trustDialogState(TRUST_LIVE_UNNUMBERED + 'No,exit\n❯Yes,Itrustthisfolder\n').cursor).toBe(2)
  })

  it('finds Yes second and the cursor on "No, exit" in the current layout', () => {
    expect(trustDialogState(TRUST_NO_FIRST)).toEqual({ yes: 2, no: 1, cursor: 1 })
  })

  it('finds Yes first and the cursor on it in the older layout', () => {
    expect(trustDialogState(TRUST_YES_FIRST)).toEqual({ yes: 1, no: 2, cursor: 1 })
  })

  it('survives Tabby dropping the spaces between glyphs', () => {
    expect(trustDialogState('❯1.No,exit\n2.Yes,Itrustthisfolder')).toEqual({ yes: 2, no: 1, cursor: 1 })
  })

  it('reads the cursor from the LATEST render, after a ↓ repaints the menu', () => {
    // The buffer is append-only: the first frame stays above the repaint.
    const afterDown = TRUST_NO_FIRST + '  1. No, exit\n❯ 2. Yes, I trust this folder\n'
    expect(trustDialogState(afterDown).cursor).toBe(2)
  })

  it('also reads a repaint that only rewrote the changed line', () => {
    expect(trustDialogState(TRUST_NO_FIRST + '❯ 2. Yes, I trust this folder\n').cursor).toBe(2)
  })

  it('leaves the cursor undefined when no option carries the glyph — never a guess', () => {
    const state = trustDialogState('1. No, exit\n2. Yes, I trust this folder')
    expect(state.yes).toBe(2)
    expect(state.cursor).toBeUndefined()
  })
})

describe('mcpApprovalDialogVisible', () => {
  it('spots the first-launch MCP approval prompt', () => {
    const screen = `New MCP server found in .mcp.json: github
❯ 1. Use this and all future MCP servers in this project
  2. Use this MCP server
  3. Continue without using this MCP server`
    expect(mcpApprovalDialogVisible(screen)).toBe(true)
    expect(mcpApprovalDialogVisible(IDLE_TAIL)).toBe(false)
  })
})

describe('claudeInputReady', () => {
  it('is ready at the idle footer', () => {
    expect(claudeInputReady(IDLE_TAIL)).toBe(true)
  })

  it('is ready on the welcome placeholder', () => {
    expect(claudeInputReady('╭───╮\n❯ Try "fix lint errors"\n')).toBe(true)
  })

  it('is NOT ready on either trust layout, the auto-mode dialog, the picker or MCP', () => {
    expect(claudeInputReady(TRUST_NO_FIRST)).toBe(false)
    expect(claudeInputReady(TRUST_YES_FIRST)).toBe(false)
    expect(claudeInputReady('Set up auto mode for your environment?\n❯ 1. Set it up\n  2. Not now')).toBe(false)
    expect(claudeInputReady('❯ 1. Resume from summary (recommended)\n  2. Resume full session as-is')).toBe(false)
    expect(claudeInputReady('New MCP server found in .mcp.json: x\n❯ 1. Use this MCP server')).toBe(false)
  })

  it('ignores footer words that are only in the repainted history, far above the tail', () => {
    const history = 'we discussed auto mode for agents\n' + 'plain history line\n'.repeat(30)
    expect(claudeInputReady(history)).toBe(false)
  })

  it('is not ready on an empty capture', () => {
    expect(claudeInputReady('')).toBe(false)
  })
})

const PLACEHOLDER_SCREEN = `
  ⏸ cctabs suspended — gapminder · 2.1MB · ~/Dev/gapminder
    press Enter to resume
`

describe('suspended marker', () => {
  it('classifies a waiting placeholder as suspended, not as a bare terminal', () => {
    expect(classifyTerminalBuffer(PLACEHOLDER_SCREEN)).toBe('suspended')
    expect(suspendMarkerShowing(PLACEHOLDER_SCREEN)).toBe(true)
  })

  it('classifies it as suspended even under the old Claude UI it replaced', () => {
    expect(classifyTerminalBuffer(IDLE_TAIL + PLACEHOLDER_SCREEN)).toBe('suspended')
  })

  it('stops saying suspended once the tab has woken — the marker is history then', () => {
    const woken = PLACEHOLDER_SCREEN + 'w1a2b3c4\n\n▶ cctabs: resuming gapminder (w1a2b3c4)\n' + IDLE_TAIL
    expect(suspendMarkerShowing(woken)).toBe(false)
    expect(classifyTerminalBuffer(woken)).toBe('idle')
  })

  it('never concludes suspended from an empty capture', () => {
    expect(classifyTerminalBuffer('')).toBe('unreadable')
    expect(suspendMarkerShowing('')).toBe(false)
  })
})

describe('isSuspended', () => {
  const base = { registered: false, claudeRunning: false, bufferMarker: false }

  it('is never true without a positive signal — emptiness is not suspension', () => {
    expect(isSuspended(base)).toBe(false)
    expect(isSuspended({ ...base, placeholder: 'absent', shellAlive: false })).toBe(false)
    expect(isSuspended({ ...base, shellAlive: undefined })).toBe(false)
  })

  it('trusts a waiting placeholder process above everything else but a running Claude', () => {
    expect(isSuspended({ ...base, placeholder: 'waiting' })).toBe(true)
    expect(isSuspended({ ...base, placeholder: 'waiting', claudeRunning: true })).toBe(false)
  })

  it('reads a woken placeholder as awake, whatever the registry says', () => {
    expect(isSuspended({ ...base, registered: true, placeholder: 'woken' })).toBe(false)
  })

  it('treats a registry entry contradicted by a live non-placeholder shell as stale', () => {
    expect(isSuspended({ ...base, registered: true, placeholder: 'absent', shellAlive: true })).toBe(false)
  })

  it('keeps a registered tab with no live shell suspended (dormant after a Tabby restart)', () => {
    expect(isSuspended({ ...base, registered: true, placeholder: 'absent', shellAlive: false })).toBe(true)
    expect(isSuspended({ ...base, registered: true, placeholder: 'absent' })).toBe(true)
  })

  it('without a process table, falls back to the registry, then the marker', () => {
    expect(isSuspended({ ...base, registered: true })).toBe(true)
    expect(isSuspended({ ...base, bufferMarker: true })).toBe(true)
  })

  it('does not let a stale on-screen marker override a readable process table', () => {
    expect(isSuspended({ ...base, bufferMarker: true, placeholder: 'absent', shellAlive: true })).toBe(false)
  })
})
