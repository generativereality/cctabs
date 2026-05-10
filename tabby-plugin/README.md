# tabby-cctabs

Tabby plugin that exposes a small local HTTP API the [`cctabs`](https://github.com/generativereality/cctabs) CLI uses to drive Tabby tabs.

The cctabs CLI was originally Wave-Terminal-only. This plugin makes Tabby a first-class supported backend.

## Install

Easiest path: Tabby → **Settings → Plugins**, search "cctabs", click install, then quit + reopen Tabby.

Programmatic (macOS):

```sh
TABBY_PLUGINS="$HOME/Library/Application Support/tabby/plugins"
mkdir -p "$TABBY_PLUGINS"
[ -f "$TABBY_PLUGINS/package.json" ] || echo '{"private":true}' > "$TABBY_PLUGINS/package.json"
npm install --legacy-peer-deps --prefix "$TABBY_PLUGINS" tabby-cctabs
```

`--legacy-peer-deps` is required: the plugin's peer deps (`tabby-core`, `@angular/*`, …) ship as part of Tabby itself, not on npm. Linux uses `${XDG_CONFIG_HOME:-$HOME/.config}/tabby`, Windows uses `%APPDATA%\tabby`.

After install, quit Tabby and reopen it (plugins load at startup), then verify with `curl http://127.0.0.1:3300/api/health` or `cctabs doctor`.

For local development, see *Build and sideload* below.

## API surface

All endpoints bind to `127.0.0.1:3300` by default. Override host/port in Tabby's settings under **cctabs**.

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/health` | `{ ok: true, version }` |
| `GET`  | `/api/tabs` | `{ tabs: [{ uuid, title, customTitle, hasFocus, type, cwd, pid }] }` |
| `POST` | `/api/tabs/identify` | body `{ pids: number[] }` → `{ uuid }` (404 if none match) |
| `POST` | `/api/tabs/new` | body `{ cwd?, command?, title? }` → `{ uuid }` |
| `POST` | `/api/tabs/:uuid/send` | body `{ data }` → `{}` |
| `POST` | `/api/tabs/:uuid/close` | `{}` |
| `PUT`  | `/api/tabs/:uuid/title` | body `{ title }` → `{}` |
| `GET`  | `/api/tabs/:uuid/buffer?lines=N` | `{ lines: string[], totalLines }` |
| `GET`  | `/api/tabs/:uuid/cwd` | `{ cwd }` |

Tab identity is a v4 UUID assigned on `tabOpened$` and discarded on `tabClosed$`. The same UUID is used everywhere.

`/api/tabs/identify` is how cctabs (running inside a Tabby tab) figures out which tab it lives in. cctabs walks its own `process.pid → ppid → …` chain and POSTs the resulting PID list. The plugin matches against each tab's `session.getPID()` and `session.getChildProcesses()`.

## Build and sideload

The plugin's webpack config delegates to upstream Tabby's `webpack.plugin.config.mjs`, so building requires a local clone of Tabby.

```sh
# One-time: clone Tabby alongside cctabs and install its deps.
git clone https://github.com/Eugeny/tabby ../related-repos/tabby
cd ../related-repos/tabby
yarn
yarn run build:typings
cd -

# Build + sideload this plugin.
npm install
npm run build
npm run sideload
```

The sideload script copies `dist/` and `package.json` into Tabby's plugins folder (`~/Library/Application Support/tabby/plugins/node_modules/tabby-cctabs/` on macOS). Restart Tabby after each rebuild.

Override Tabby's repo location with `TABBY_REPO=/path/to/tabby npm run build`.

## License

MIT
