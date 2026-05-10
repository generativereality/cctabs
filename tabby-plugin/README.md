# @generativereality/tabby-cctabs

Tabby plugin that exposes a small local HTTP API the [`cctabs`](https://github.com/generativereality/cctabs) CLI uses to drive Tabby tabs.

The cctabs CLI was originally Wave-Terminal-only. This plugin makes Tabby a first-class supported backend.

## Install

When the plugin is published, install it from Tabby → **Settings → Plugins** (search "cctabs").

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
