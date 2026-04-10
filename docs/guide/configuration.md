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
# Default Wave workspace to open new sessions in.
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

## Check current config

```bash
cctabs config
```

Prints the config file path and current values.
