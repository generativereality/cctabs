# Tabby support — full plan

cctabs today is Wave-only: every command imports `requireWaveAdapter` from
`src/core/wave.ts`. This document captures the multi-phase plan for adding
Tabby Terminal as a second supported backend, with full feature parity, via
a custom Tabby plugin we ship in this repo.

Last updated: 2026-05-10.

## Context / motivation

Wave Terminal has been unstable in recent versions. Tabby
(<https://tabby.sh>, very actively maintained) is a candidate alternative,
but its automation surface is much narrower than Wave's: there is no built-in
HTTP/IPC for external processes to list tabs, send input, read scrollback, or
get tab identity. The existing community plugin
[`tabby-mcp-server`](https://github.com/thuanpham582002/tabby-mcp-server)
exposes a partial HTTP/SSE surface (see `notes/research/` if/when we capture
it), but is unmaintained (last release 2025-06-28, open bugs unanswered) and
covers only ~40% of what cctabs needs.

We're going to build our own Tabby plugin (`tabby-plugin/` in this repo) that
exposes a clean local HTTP API mirroring Wave's surface, then add a Tabby
backend to cctabs that talks to it.

## Architecture

```
+---------------------+      HTTP localhost:<port>    +---------------------+
| cctabs CLI          |  <----------------------->    | Tabby plugin        |
|  TabbyAdapter       |                               |  (this repo's       |
|  (src/core/tabby.ts)|                               |   tabby-plugin/)    |
+---------------------+                               +-----+---------------+
        ^                                                   |
        |                                                   | Angular DI
        | TerminalAdapter                                   v
        |                                             +---------------------+
+-------+-------------+      Wave RPC + wsh           | Tabby AppService    |
|  WaveAdapter        | <-------------------------    | tabsService etc.    |
|  (src/core/wave.ts) |                               | BaseTabComponent    |
+---------------------+                               +---------------------+
```

### Why this shape

- **Tab identity is the linchpin.** A CLI launched inside a Tabby tab needs to
  know *which* tab it lives in (so `cctabs sessions` can mark the current tab,
  so `cctabs send` can default to the current tab, etc). Wave does this via
  `WAVETERM_TABID` env var. Tabby sets no equivalent. Patching Tabby to inject
  one would require an upstream change. **Solution: PID-walk identity.**
  - Tabby's `tabby-local/Session` exposes `pty.getPID()` and
    `getChildProcesses()` for every open tab.
  - The plugin maintains a stable UUID per `BaseTabComponent` and a reverse
    map `pid → tabUuid` covering each tab's shell + descendants.
  - cctabs (running inside a Tabby tab) walks `process.pid → parent → … `
    via `ps -o ppid= -p <pid>` and POSTs the chain to
    `POST /api/tabs/identify`. The plugin returns the tab UUID owning any
    matching ancestor PID.
  - No env injection, no shell rc tweaks, no Tabby patch.

- **Plugin lives in this repo.** Easier to keep cctabs and the plugin in
  lockstep than two repos with version drift.

## Plugin HTTP API (proposed)

All endpoints are JSON in/out; bind only to `127.0.0.1`; port configurable in
the plugin's settings tab (default `3300` — distinct from
`tabby-mcp-server`'s `3001` so the two can coexist).

| Method | Path | Purpose |
|---|---|---|
| GET  | `/api/health` | `{ ok: true, version }` |
| GET  | `/api/tabs` | List `[ { uuid, title, customTitle, hasFocus, type, cwd?, pid? } ]` |
| POST | `/api/tabs/identify` | body `{ pids: number[] }` → `{ uuid }` or `404` |
| POST | `/api/tabs/new` | body `{ cwd?, command?, title? }` → `{ uuid }` |
| POST | `/api/tabs/:uuid/send` | body `{ data }` → `{}` |
| POST | `/api/tabs/:uuid/close` | `{}` |
| PUT  | `/api/tabs/:uuid/title` | body `{ title }` → `{}` |
| GET  | `/api/tabs/:uuid/buffer?lines=N` | `{ lines: string[], totalLines }` |
| GET  | `/api/tabs/:uuid/cwd` | `{ cwd }` |

Implementation details:

- UUIDs assigned on `app.tabOpened$`, removed on `app.tabClosed$`. Stored in a
  `WeakMap<BaseTabComponent, string>` plus a forward `Map<string, BaseTabComponent>`.
- `/api/tabs/new` uses `tabsService` + `app.openNewTabRaw` (the same path
  Tabby's own `tabby open` CLI takes).
- `/api/tabs/:uuid/buffer` uses `@xterm/addon-serialize`'s `SerializeAddon`,
  same trick as `tabby-mcp-server`.
- `/api/tabs/:uuid/cwd` calls `session.getWorkingDirectory()` (Tabby tracks
  this for OSC-7-aware shells; falls back to `guessedCWD`).
- `/api/tabs/identify` walks each tab's `getChildProcesses()` once per call
  to get an up-to-date PID set; returns the first tab whose PID set
  intersects the caller's ancestor chain.

## Phases

### Phase 0 — Plan doc (this file) ✓

### Phase 1 — Extract `TerminalAdapter` interface (cctabs-side, no Tabby yet)

**Goal:** decouple commands from `WaveAdapter` so a second backend slots in.
No behavioural change.

Steps:

1. Define `TerminalAdapter` in `src/core/adapter.ts` covering the shape every
   command currently uses on `WaveAdapter`:
   - `getAllData()`, `closeSocket()`
   - `blocksList()`, `scrollback()`, `confirmScrollbackEmpty()`,
     `detectSessionStatus()`, `deleteBlock()`, `newTab()`, `waitForNewBlock()`
   - `getTab()`, `workspaceList()`, `focusWindow()`, `renameTab()`,
     `sendInput()`
   - `resolveTab()`, `resolveBlock()`, `resolveWorkspace()`
2. Make `WaveAdapter implements TerminalAdapter` (no API changes).
3. Replace `requireWaveAdapter()` with `requireAdapter()` returning
   `TerminalAdapter`. Keep `requireWaveAdapter()` as an alias for
   doctor-specific code (which only makes sense on Wave).
4. Update every `src/commands/*.ts` import.
5. Run `cctabs sessions`, `list`, `scrollback`, `send` inside Wave to confirm
   no regression.

**Done when:** type-check passes, manual smoke test on Wave is identical.

### Phase 2 — Scaffold `tabby-plugin/` directory

**Goal:** an empty Tabby plugin we can sideload that prints
`"cctabs plugin loaded"` to Tabby's dev console.

Steps:

1. Mirror `tabby-mcp-server`'s layout: `package.json` (Angular peer deps,
   `tabby-core` peer dep), `webpack.config.mjs`, `tsconfig.json`,
   `src/index.ts` (NgModule), `assets/icon.svg`.
2. Add a top-level `npm run build:tabby-plugin` script.
3. Wire up plugin manifest (`package.json` `keywords: ['tabby-plugin']`).
4. Document sideload path: `~/Library/Application Support/tabby/plugins/`
   on macOS.

**Done when:** running Tabby with the built plugin sideloaded shows the
console log.

### Phase 3 — Plugin core: HTTP + tab UUIDs + endpoints

**Goal:** the full API table above is implemented and reachable from `curl`.

Steps:

1. Settings tab with port + bind-host fields (default `127.0.0.1:3300`).
2. `TabRegistry` service: WeakMap + forward map of UUIDs, subscribed to
   `tabOpened$`/`tabClosed$`.
3. `PidIndex` service: refreshable map `pid → tabUuid` from
   `getChildProcesses()`.
4. Express server with the endpoints from the API table. Auth: bind-host
   defaults to loopback only; optional bearer token in settings.
5. Logger.

**Done when:** `curl localhost:3300/api/tabs` returns the live tab list, and
`curl -XPOST .../api/tabs/identify -d '{"pids":[$$]}'` from a tab shell
returns that tab's UUID.

### Phase 4 — `TabbyAdapter` on cctabs side

**Goal:** every cctabs command works under Tabby.

Steps:

1. Add `'tabby'` to `KnownTerminal`; detect via `TERM_PROGRAM === 'Tabby'`
   in `terminal.ts`.
2. `src/core/tabby.ts` — `TabbyAdapter implements TerminalAdapter`. Maps to
   the plugin's HTTP API. Configurable plugin port via env var
   `CCTABS_TABBY_PORT` or a small `~/.config/cctabs/tabby.json`.
3. Identity: on first call to `getAllData()`, walk `process.pid` ancestors
   via `ps -o ppid= -p N` chain (cap at 32 levels), POST to `/identify`,
   cache the resulting UUID for this process.
4. `requireAdapter()` returns `TabbyAdapter` when `detectTerminal() === 'tabby'`.
5. `cctabs doctor` prints "Wave-only" on Tabby (it's Wave-DB-specific).

**Done when:** `cctabs sessions`, `new`, `close`, `rename`, `send`,
`scrollback`, `fork` all work with the plugin running.

### Phase 5 — Docs + plugin distribution

Steps:

1. `docs/guide/troubleshooting.md` — "Plugin not running" section, port
   conflicts, identity failure modes.
2. `docs/guide/getting-started.md` — Tabby install path: install Tabby,
   install the cctabs plugin (sideload or via Tabby's plugin manager once
   we publish), then run cctabs.
3. Publish the plugin to npm as `@generativereality/tabby-cctabs` so Tabby's
   plugin manager can discover it (Tabby plugin manager queries npm for
   `keywords: ['tabby-plugin']`).
4. `scripts/sync-plugin.sh` extension or new `scripts/sync-tabby-plugin.sh`
   to keep the published plugin version in lockstep with the cctabs CLI.

### Bonus — launch Claude in Tabby from this Wave session ✓

Validated 2026-05-10 from inside this Wave-hosted Claude session.

What worked:

```sh
brew install --cask tabby
open -a Tabby                                  # ensure Tabby is running

cat > /tmp/tabby-claude-launcher.sh <<'EOF'
#!/bin/zsh -l
cd /Users/motin/Dev/Projects/generativereality/cctabs || exit 1
exec /Users/motin/.local/bin/claude --resume <session-id> --fork-session
EOF
chmod +x /tmp/tabby-claude-launcher.sh

/Applications/Tabby.app/Contents/MacOS/Tabby run /tmp/tabby-claude-launcher.sh
```

Gotchas surfaced by the experiment:

- `Tabby run zsh -lc "<cmd>"` does **not** work — Tabby's argv parsing drops
  `-lc` somewhere and ends up calling `zsh "<cmd>"`, which zsh interprets as
  a script filename (`zsh: can't open input file: cd …`). Use a launcher
  script instead, or `Tabby run /bin/zsh /path/to/script`.
- The launched command must reference `claude` by absolute path
  (`/Users/motin/.local/bin/claude`) unless the launcher script sources a
  shell that puts `~/.local/bin` on `PATH` (the `#!/bin/zsh -l` shebang does).
- `--fork-session` is essential when the source session is still active —
  plain `--resume` would race against the live transcript.
- macOS shows a per-tab approval prompt for every `Tabby run` invocation. If
  you fire several `run`s in a row without approving them, Tabby silently
  queues the IPC requests; once you start approving the dialogs they all
  fire at once and you end up with N duplicate tabs. **Workflow: send one
  `run`, approve the dialog, verify the tab opened, then send the next.**
- After Tabby's IPC handler appears stuck (no `Starting profile` log line
  after a `CLI arguments received`), check macOS for unhandled approval
  dialogs before assuming Tabby is broken.

Caveat: from *this* Claude session we can launch Tabby tabs but we can't
interact with them. That's exactly the gap phases 2–4 close.

## Status checklist

- [x] Phase 0 — plan doc
- [x] Phase 1 — TerminalAdapter interface + WaveAdapter conformance
- [x] Phase 2 — tabby-plugin scaffold (sources written; first build deferred — see *Build verification* below)
- [x] Phase 3 — plugin core (HTTP + endpoints)
- [x] Phase 4 — TabbyAdapter on cctabs side
- [x] Phase 5 — docs + distribution scaffold (publish + sideload deferred)
- [x] Bonus — launch-Claude-in-Tabby-from-Wave smoke test (2026-05-10)

## Build verification — what's left before the plugin is real

The plugin source compiles in isolation (we did not run a full webpack
build in the writing session — that requires `yarn install` + `yarn run
build:typings` inside a local clone of upstream Tabby, which pulls Angular
15 + Electron native modules and is slow). To go from "scaffold" to "real":

1. `cd related-repos/tabby && yarn && yarn run build:typings` (one-time).
2. From repo root: `npm run build:tabby-plugin`. The plugin's
   `webpack.config.mjs` resolves the shared Tabby webpack config under
   `related-repos/tabby/webpack.plugin.config.mjs`.
3. `cd tabby-plugin && npm run sideload` to copy `dist/` and
   `package.json` into Tabby's plugin folder
   (`~/Library/Application Support/tabby/plugins/node_modules/tabby-cctabs/`).
4. Restart Tabby. Open dev tools (Settings → Advanced → Open dev tools)
   and check the console for `[cctabs] plugin loaded`.
5. `curl http://127.0.0.1:3300/api/health` should return
   `{ ok: true, version: "0.1.0" }`.
6. Inside a Tabby tab: `cctabs sessions` should now succeed without the
   "switch to Wave" message.

If the build needs adjustments after the first end-to-end run, expect them
in `webpack.config.mjs` (externals list) and `src/server.ts` (the
`tabby-terminal` lazy-load in `openNewTab` may need a different export
name). Both are noted in `tabby-plugin/src/server.ts:openNewTab`.

## Known unknowns / risks to revisit

- **Tabby plugin loading API stability.** Tabby's plugin format is
  well-documented but evolves; the build setup may need tweaks across
  Tabby releases.
- **Express dependency in a webpack-bundled Tabby plugin.** May need a
  smaller HTTP server (e.g. `node:http` directly) to keep bundle size
  down and avoid cjs/esm headaches inside Tabby's webpack.
- **PID walk on Linux/Windows.** macOS uses `ps -o ppid= -p N`; Linux works
  identically; Windows needs `wmic` or `Get-CimInstance Win32_Process`.
  Initial implementation can be macOS+Linux only.
- **Multiple Tabby windows.** A single plugin instance covers all windows;
  the API exposes only "tabs" — we don't model windows. May need to
  revisit if a workspace-like grouping shows up.
- **Distribution discoverability.** Tabby's plugin manager pulls from npm
  using a `tabby-plugin` keyword. We need both that keyword *and* a working
  Tabby plugin manifest (`package.json` `tabby` field) for the manager to
  see us.
