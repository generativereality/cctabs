import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ProcRow } from './claude-procs.js'

/**
 * A fleet saved for a restart, and the restart itself, minus the I/O.
 *
 * Two flows share this: `cctabs restart-tabby` (save, close, quit Tabby,
 * reopen it, restore) and `cctabs prepare-reboot` (save and close, then the
 * user reboots and runs `cctabs restore --pending`). What they have in common
 * is a **pending restore**: a saved manifest plus a marker saying it is
 * waiting, so whatever runs next — a restore tab the worker opens, or the user
 * after a reboot — knows there is a fleet to bring back without being told the
 * path.
 *
 * Each rule here is something the hand-run version of this got wrong on
 * 2026-10-15: a manifest of 0 entries reported as saved, a retry loop that
 * nearly overwrote the good save, and closes that had to be done by tab id.
 */

/** Where saved fleets live: `CCTABS_FLEET_DIR`, default `~/.config/cctabs/fleet`. */
export function fleetDir(env: Record<string, string | undefined> = process.env): string {
  return env.CCTABS_FLEET_DIR || join(homedir(), '.config', 'cctabs', 'fleet')
}

export type PendingReason = 'tabby-restart' | 'reboot'

export interface PendingRestore {
  /** Absolute path of the saved manifest. */
  manifest: string
  /** ISO time it was saved. */
  savedAt: string
  reason: PendingReason
  /** Sessions in the manifest. */
  sessions: number
  /** Passed to `restore --suspend-older-than` when the restore runs. */
  suspendOlderThan?: string
  /** Tabs that had no Claude session, so cannot come back. Named for the report. */
  noSession: string[]
}

export function pendingPath(dir: string = fleetDir()): string {
  return join(dir, 'pending-restore.json')
}

export function readPending(dir: string = fleetDir()): PendingRestore | null {
  const p = pendingPath(dir)
  if (!existsSync(p)) return null
  try {
    const v = JSON.parse(readFileSync(p, 'utf-8')) as PendingRestore
    return v && typeof v.manifest === 'string' && typeof v.savedAt === 'string' ? v : null
  } catch {
    return null
  }
}

/** Atomic: a reader never sees half a marker. */
export function writePending(p: PendingRestore, dir: string = fleetDir()): void {
  mkdirSync(dir, { recursive: true })
  const file = pendingPath(dir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n')
  renameSync(tmp, file)
}

export function clearPending(dir: string = fleetDir()): void {
  try { unlinkSync(pendingPath(dir)) } catch { /* already gone */ }
}

/** A new, never-overwritten path for a save: `manifest-YYYYMMDD-HHMMSS.json`. */
export function stampedManifestPath(now: Date, dir: string = fleetDir()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return join(dir, `manifest-${stamp}.json`)
}

/**
 * Is a capture complete enough to close tabs on? Pure.
 *
 * The capture must have seen exactly the tabs the terminal has right after it:
 * a different set means tabs opened or closed mid-capture, or a read came back
 * short. And it must have errors-free entries — a manifest restore can't act on
 * (two tabs sharing a name, say). Either way nothing is closed.
 */
export function checkCapture(o: {
  capturedTabIds: string[]
  liveTabIds: string[]
  errors: string[]
}): { ok: true } | { ok: false; message: string } {
  const captured = new Set(o.capturedTabIds)
  const live = new Set(o.liveTabIds)
  const missed = [...live].filter((t) => !captured.has(t))
  const gone = [...captured].filter((t) => !live.has(t))
  if (missed.length || gone.length) {
    return {
      ok: false,
      message:
        `The tab list changed while saving (${missed.length} tab(s) not captured, ${gone.length} gone since). ` +
        'Nothing was closed. Run it again once tabs have stopped opening and closing.',
    }
  }
  if (o.errors.length) {
    return { ok: false, message: `The saved fleet would not restore cleanly, so nothing was closed:\n  ${o.errors.join('\n  ')}` }
  }
  return { ok: true }
}

/**
 * The entries a restart brings back: only those with a session. Pure.
 *
 * In a manifest, an entry with no session means "start a fresh Claude here".
 * Right for a hand-written manifest, wrong for a restart: a plain shell tab, or
 * the tab that ran the restart, came back as a NEW Claude sitting at the
 * folder-trust dialog, right after the save had said it "won't come back"
 * (measured on Windows, 2026-10-15).
 */
export function restorableEntries<E extends { session_id?: string }>(entries: E[]): E[] {
  return entries.filter((e) => !!e.session_id)
}

/**
 * The suspend age to restore with when the user gave none. Restoring a large
 * fleet all at once is what pushed this machine to load 575 with 96 Claudes;
 * above 30 sessions, sessions idle for 3 days come back suspended (they wake on
 * Enter or `cctabs send`).
 */
export function defaultSuspendAge(sessions: number): string | undefined {
  return sessions > 30 ? '3d' : undefined
}

// ---- Tabby the process ----

export type Platform = 'darwin' | 'linux' | 'win32'

/**
 * Pids of Tabby's MAIN process in a `ps` table. Pure.
 *
 * Not "anything named Tabby": macOS helpers live at `…/Tabby Helper.app/…`, so
 * a first-word match finds them too, and Linux Electron helpers are the same
 * binary run with `--type=…`.
 */
export function tabbyMainPids(rows: ProcRow[], platform: Platform): number[] {
  return rows
    .filter((r) =>
      platform === 'darwin'
        ? /(^|\/)Tabby\.app\/Contents\/MacOS\/Tabby(\s|$)/.test(r.command) && !/--type=/.test(r.command)
        : /(^|\/)tabby(\s|$)/i.test(r.command.split(/\s+/, 1)[0] ?? '') && !/--type=/.test(r.command),
    )
    .map((r) => r.pid)
}

/** Does `tasklist /FI "IMAGENAME eq Tabby.exe" /NH` show it running? Pure. */
export function tasklistShowsTabby(stdout: string): boolean {
  return /^\s*Tabby\.exe\s/im.test(stdout)
}

/** How to quit and reopen Tabby on a platform. `exePath` is Windows' (and Linux's) way back. */
export function tabbyLifecycle(platform: Platform, exePath?: string): { quit: string[]; open: string[] } {
  if (platform === 'darwin') {
    return {
      // A normal quit, the same as Cmd+Q: Tabby saves its state and closes cleanly.
      quit: ['osascript', '-e', 'tell application "Tabby" to quit'],
      open: ['open', '-a', 'Tabby'],
    }
  }
  if (platform === 'win32') {
    // No /F: ask the window to close, like clicking the X, rather than kill it.
    return { quit: ['taskkill', '/IM', 'Tabby.exe'], open: [exePath ?? 'Tabby.exe'] }
  }
  return { quit: ['pkill', '-TERM', '-x', 'tabby'], open: [exePath ?? 'tabby'] }
}

/**
 * The environment to start Tabby with. Pure.
 *
 * Never the caller's own. `restart-tabby` runs inside a Claude, and Claude
 * Code gives the processes its tools run CLAUDECODE, CLAUDE_CODE_SESSION_ID,
 * its Remote Control session, a messaging socket and CLAUDE_CODE_CHILD_SESSION=1.
 * `open -a Tabby` passed all of that to the new Tabby (measured 2026-10-15,
 * macOS), and Tabby passes its environment to every tab: each Claude started
 * there believed it was a sub-session and **saved no transcript**
 * ("Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"),
 * and carried another session's id. A backend preset's ANTHROPIC_BASE_URL would
 * have pointed every tab at that backend.
 *
 * macOS gets what the Dock would give it: a short allowlist. Elsewhere,
 * where an allowlist would drop what the platform needs (SystemRoot on
 * Windows, DISPLAY and friends on Linux), Claude's and cctabs' own variables
 * are removed instead.
 */
export function tabbyLaunchEnv(env: Record<string, string | undefined>, platform: Platform): Record<string, string> {
  const out: Record<string, string> = {}
  if (platform === 'darwin') {
    for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING']) {
      const v = env[k]
      if (v !== undefined) out[k] = v
    }
    return out
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(CLAUDE|ANTHROPIC_|CCTABS_)/i.test(k)) continue
    out[k] = v
  }
  return out
}
