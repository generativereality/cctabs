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

## Check current config

```bash
cctabs config
```

Prints the config file path and current values.
