---
title: Configuration — cctabs
description: Configure cctabs with ~/.config/cctabs/config.toml. Set default Claude Code flags, workspace targets, and per-session options.
---

# Configuration

Config file: `~/.config/cctabs/config.toml`

Created automatically on first run of `cctabs config`.

## Options

```toml
[claude]
# Extra flags passed to every `claude` invocation.
flags = ["--allow-dangerously-skip-permissions"]

[defaults]
# Default workspace to open new sessions in. Inert on Tabby, which has no
# workspace concept — kept for config compatibility.
# workspace = ""

# Colour for every tab opened by new/resume/fork.
# color = ""
```

## claude.flags

Flags appended to every `claude` command launched by `cctabs new`, `cctabs resume`, and `cctabs fork`.

The default config ships with `--allow-dangerously-skip-permissions` enabled — remove it if you prefer manual permission prompts.

Other examples:

```toml
[claude]
flags = ["--model", "sonnet", "--allow-dangerously-skip-permissions"]
```

## defaults.workspace

If set, `cctabs new` will open tabs in this workspace by default (without needing `-w`).

```toml
[defaults]
workspace = "work"
```

## defaults.color

Colour applied to every tab opened by `cctabs new`, `resume` and `fork`.

```toml
[defaults]
color = "blue"
```

Accepts Tabby's palette names — `blue`, `green`, `orange`, `purple`, `red`,
`yellow` — plus `none`, or a hex value like `"#0275d8"`. Precedence runs
`--color` → the backend preset's own `color` → this. Empty (the default) leaves
tabs uncoloured.

Colours survive a reboot: `cctabs restore` re-applies them, because it *recreates*
a dead tab rather than reviving it and a fresh tab starts uncoloured. A tab whose
colour wasn't recorded takes whatever the config implies for its backend, so this
rule keeps holding for sessions captured before colours existed.

Requires a `tabby-cctabs` plugin advertising the `tab-color` capability; an
older plugin warns once and opens the tab uncoloured rather than failing.

## Backends

A backend preset is a named set of environment variables (plus an optional
model) applied when a tab launches. Use it for a different model provider — or
for **a different Claude account entirely**, e.g. keeping a client's usage
separate from your own.

```bash
cctabs backends                      # list presets
cctabs new scratch ~/Dev/app -b kimi # launch a tab on one
```

Presets ship built in (Ollama-backed: `kimi`, `qwen-cloud`, `gpt-oss`, …) and can
be added under `[backends.<name>]`. Two forms:

```toml
# A different model/provider — base_url + auth_token shorthand:
[backends.my-preset]
description = "My custom preset"
model = "qwen3-coder-next:cloud"
base_url = "http://localhost:11434"

# Full control via env_<NAME> — including a different Claude account:
[backends.client-x]
description = "Client X's Claude account"
env_CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-..."
env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-client-x"
```

### Inheritance

A launched tab carries `CCTABS_ACTIVE_BACKEND=<name>`, so `new` / `resume` /
`fork` run from *inside* that session default to the same preset instead of
falling back to your default account. Explicit `-b` wins; `-b anthropic` forces
the default back.

### Multiple Claude accounts

A preset that sets `env_CLAUDE_CONFIG_DIR` puts its sessions in that directory
rather than `~/.claude/projects`. cctabs searches every config dir it knows about
— the default one plus each one named by a preset — so those sessions show up in
`cctabs sessions`, `resume` and `restore` like any other, and are relaunched
under the account they belong to automatically.

This matters more than a missing-session error would: `claude --resume <id>` run
against the wrong config dir doesn't fail, it just can't find that id and opens a
*fresh* conversation. Carrying the account through is what prevents a restore
that looks successful and isn't.

Give each account a `color` and which one a tab belongs to becomes visible in the
tab bar instead of something to remember:

```toml
[backends.work]
env_CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-..."
env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-work"
color = "blue"
```

A preset's `color` applies to every tab launched under it and overrides
`[defaults] color`; `--color` still wins over both. Because the account is
inferred from the config dir a session was found in, `cctabs restore` puts those
tabs back blue after a reboot without anything having to be recorded per tab.

A common pairing is one colour per account plus a catch-all:

```toml
[defaults]
color = "orange"          # everything else

[backends.enterprise]
env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-enterprise"
color = "blue"            # this account's tabs
```

Note `[defaults] color` is the right place for the catch-all, not
`[backends.anthropic]`: a plain `cctabs new foo` resolves to *no* backend at all,
so a colour on the `anthropic` preset only applies when you pass `-b anthropic`
explicitly.

A `[backends.<name>]` section **overlays** the builtin preset of that name rather
than replacing it, so you can add just a `color` to `kimi` or `qwen-cloud` without
restating its base URL, token and model.

## Check current config

```bash
cctabs config
```

Prints the config file path and current values.
