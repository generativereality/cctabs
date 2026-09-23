# Tab order, colours and names

> Read when pinning or sorting tabs, colouring them, renaming a tab or its live session, setting a per-machine name prefix, or choosing tab names.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Getting a working set in reach — `cctabs sort --first`

Activity order is close to the *opposite* of what a driver wants: a tab that
just delivered sinks to the bottom. To pin a chosen set instead:

```bash
cctabs sort --first auth,payments,billing        # these three to the front, in this order
cctabs sort --first auth,payments --dry          # show the plan first
```

Every unlisted tab keeps its current relative order and sorts after the pinned
ones. If any name doesn't resolve to exactly one tab, **nothing is moved** and
the command exits non-zero — half a working set in reach, with no indication
which half, is worse than an error. Tabby only.

## Tab colours

`-c/--color` on `new`/`resume`/`fork`, or `cctabs color <tab> <colour>` for a tab
that already exists. Values: `blue`, `green`, `orange`, `purple`, `red`,
`yellow`, `none`, or hex (`#0275d8`). Use it when the user asks to colour, tag or
visually group tabs — e.g. one colour per repo, per PR, or per Claude account.

Set `[defaults] color` in `~/.config/cctabs/config.toml` to colour every new tab,
or `color` inside a `[backends.<name>]` section to colour one account's tabs.
Precedence: `--color` → backend preset → `[defaults]`.

Colours survive `cctabs restore` (and therefore a reboot): restore re-applies
them from the manifest, from the tab being replaced, or from the config rule for
that session's account. A per-account colour is the recommended setup — it keeps
holding without anything recorded per tab.

Requires a `tabby-cctabs` plugin that advertises the `tab-color` capability. With
an older plugin the colour is skipped with a warning and the tab still opens;
`cctabs color` exits non-zero, since colouring was the whole request.

## Two names: the tab title vs. the claude session (RC) name

Every session actually carries **two independent names**, and it's easy to change one while assuming you changed both:

1. **Tabby tab title** — the text on the terminal tab. Set by `cctabs new`/`resume`/`fork`, and changeable with `cctabs rename`.
2. **The claude session name** — the **remote-control (RC) session name shown on claude.ai** when you control the session from the web/mobile app. It mirrors the session's **current local name**, which is *initialized* from the launch `--name` (what cctabs passes) and thereafter changed by `/rename`.

There's also a third, on-disk name that matters for lookup: the **`customTitle` recorded in the session's `.jsonl`**, which is what `cctabs resume <name>` / `restore` search by. cctabs writes it at launch via `--name`; **Claude's in-session `/rename` does NOT rewrite it** (it only relabels the live/RC session), so a session renamed *only* with `/rename` stays findable by resume under its **original** name — a known limitation.

`cctabs rename <tab> <newName>` changes the **tab title** and now **also persists `customTitle` to the session's `.jsonl`**, so `cctabs resume <newName>` finds it afterwards. It still does **not** touch the running claude session, so the claude.ai RC name is unchanged. To rename the **live** claude session (and therefore its RC name), send Claude Code's `/rename` slash command into the tab:

```bash
cctabs rename mytab new-title                 # tab title + on-disk customTitle (so `resume new-title` finds it)
cctabs send mytab "/rename new-title"          # live claude session + RC name (Claude replies "Session renamed to: …")
```

Use both together when you want the tab title, the resume-by-name lookup, and the RC name all in sync on an already-running session.

> **How the RC name behaves (validated by controlled test).** The RC name tracks the session's **current local name** — *not* the launch `--name`. Launch `--name` only sets the *initial* name; a `/rename` changes it, and the change **persists across reconnects** — both a manual `/remote-control` toggle and an automatic (network-drop) reconnect re-register under the *current local name*, so **reconnect does NOT revert to the launch name**. The one catch: `/rename` only reaches the RC list **while the session is connected**. If you `/rename` a session whose remote-control bridge is **disconnected**, the local name changes but the RC list keeps showing the last-registered name until the session **reconnects**, at which point it syncs. So a session showing a stale name in the RC list is almost always one that was renamed **while disconnected** (or never renamed) — reconnect it, or `/rename` it once it's connected (`cctabs sessions` shows which are live). The zero-fuss option is to launch prefixed in the first place via the `prefix` config below, so the name is right from the first registration and there's nothing to re-apply.

### The `prefix` config setting

When several machines share **one claude.ai remote-control session list**, sessions from different machines can collide to the same RC name and become ambiguous. Set a per-install `prefix` so this machine stamps every name it mints:

```toml
# ~/.config/cctabs/config.toml
[defaults]
prefix = "mbp18-"
```

`cctabs config` shows the current value. When set, the prefix is prepended to **both** the tab title **and** the `claude --name` (RC name) for every name **minted** by:

- `cctabs new <name>` → tab + RC name become `mbp18-<name>`
- `cctabs resume <name>` → resolves the tab/session and re-launches `--name` in prefixed space
- `cctabs fork <src> [-n <name>]` → the new fork tab + its (now explicitly named) RC session

It is **idempotent** — a name you already typed with the prefix (`mbp18-auth`) is not prefixed twice. It does **not** retro-rename existing tabs, and `restore`/`import` keep each session's already-recorded name untouched (they reattach, they don't mint).

### Recipe: prefix all *existing* tabs on this machine

Setting `prefix` only affects newly-minted names. To retro-apply a prefix (e.g. `mbp18-`) to tabs/sessions that are already live, do both renames for each tab:

```bash
# For each existing tab NAME (from `cctabs sessions`):
cctabs rename auth mbp18-auth                  # 1. tab title
cctabs send   auth "/rename mbp18-auth"        # 2. live claude session + RC name
# (send resolves by the CURRENT name, so rename the title AFTER, or send first then rename —
#  just don't rename the title and then try to `send` by the old name.)
```

Order that's safe: **`send` the `/rename` first (matches the current title), then `cctabs rename` the tab title.** Claude acknowledges each `/rename` with "Session renamed to: …". After this one-time sweep, set `prefix` in config so all *future* tabs carry it automatically.

**The `/rename` only reaches the RC list for sessions that are currently connected** (see the note above — RC tracks the current local name, and `/rename` pushes it only over a live bridge). So:
- **Connected sessions:** `/rename` updates RC and the change survives reconnects. Done.
- **Disconnected sessions** (`cctabs sessions` shows them as `terminal`/not live): `/rename` changes the local name but RC won't reflect it until the session reconnects. Either reconnect it (it then registers under the now-prefixed local name) or `cctabs resume mbp18-<name>` it to relaunch with the prefixed `--name`.

New sessions started after `prefix` is set are correct from their first RC registration and need none of this.

## Tab Naming Conventions

Name tabs after the **project or task**:
- `auth` — authentication work
- `api` — API service
- `infra` — infrastructure
- `pr-1234` — specific PR work
- `auth-v2` — forked attempt
