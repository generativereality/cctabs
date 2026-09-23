# Backends and Claude accounts

> Read when running a tab on another model provider (Ollama, Kimi, Qwen, local) or another Claude account, or moving a session between accounts with `profile-copy`.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Moving a session between Claude accounts

`cctabs profile-copy <tab> --to <preset>` when the user wants a session that lives
under one Claude account reopened under another (e.g. personal → enterprise).
`CLAUDE_CONFIG_DIR` isolates transcripts per account, so the session is otherwise
invisible from the other side.

- Default is a **copy** — the source keeps running and the two diverge cleanly,
  like `--fork-session`.
- `--move` removes the source, but **refuses while the source is still running**.
  Add `--close-source` to close the tab, wait for its process to genuinely exit,
  and then move. Never work around this by hand: a `mv` is a rename, so the live
  `claude` keeps writing to the moved file and both tabs interleave into one
  unusable transcript.
- Always run `--dry` first when unsure — it reports the target path, the sidecar
  file count, and any relocation, without touching anything.
- The copy carries the session's **sidecar** (`subagents/`, `tool-results/`).
  Never hand-copy just the `.jsonl`; that silently discards all subagent history.
- The new tab is named `<source>-<preset>` by default so prefix matching stays
  unambiguous while the source is still open. `-n` overrides.

## Backends: running Claude Code on Ollama / Kimi / Qwen / local models — or a different Claude account

By default, `cctabs new` runs `claude` against the Anthropic API, using whatever account is logged into Claude Code's default profile. Pass `--backend <preset>` (or `-b`) to launch the tab against a different model provider (Ollama/Kimi/Qwen/local) **or a different Claude account entirely** (e.g. a separate client's or organization's subscription) — useful for cheap/free scratch sessions, privacy-sensitive work, experimenting with frontier open-weight models, or keeping a client's Claude usage cleanly separated from your own.

`cctabs` does this by prepending env vars to the `claude` command in the new tab: for model-provider presets that's `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, etc. plus `--model <name>`; for a different-account preset it's `CLAUDE_CODE_OAUTH_TOKEN` (and optionally `CLAUDE_CONFIG_DIR`) — see below.

### Built-in presets

Run `cctabs backends` for the live list. Common ones:

| Preset | What it is | When to use |
|---|---|---|
| `anthropic` (default) | Anthropic API | Production / coding work where capability matters |
| `kimi` | Kimi K2.6 via Ollama Cloud (Pro tier) | Cheap frontier alternative; ~5s/turn |
| `qwen-cloud` | Qwen3 Coder Next via Ollama Cloud | Fastest Pro option (~3.8s/turn) |
| `gemma-cloud` | Gemma4 31B via Ollama Cloud | Cheap general-purpose |
| `qwen-local` | Qwen3 Coder 30B local (18GB) | Offline / private; slow on M1 |
| `qwen-next-local` | Qwen3 Coder Next Q3_K_M local (38GB) | Private + most capable local; needs `ollama create` import |
| `gpt-oss` | gpt-oss 20B local (13GB) | Private; slow; ~100s/turn for 50k system prompt |
| `llama` | Llama 3.1 8B local | Fast but garbles inside Claude Code's 50k system prompt — capability gate |
| `*-tee` | Same as above but routed through `:11500` proxy | Wire-level inspection (`ollama-tee` proxy must be running) |

### Cost × privacy framing

Two axes matter:

1. **Cost** — Anthropic Pro $20/mo or Max ($100/$200/mo); Ollama Cloud Pro $20/mo (3 concurrent, includes Kimi/Qwen Cloud); local = free but hardware-bound
2. **Privacy** — Anthropic API: Anthropic sees prompts. Ollama Cloud: Ollama sees prompts. Local: nothing leaves the laptop

Match the tier to the task:
- Sensitive prompts (client code, customer data) → `qwen-next-local` or `gpt-oss`
- Routine exploration / orchestration → `anthropic` (default)
- Cost-sensitive bulk work → `kimi` or `qwen-cloud`

### Examples

```bash
# Spin up a tab on Kimi for a side experiment
cctabs new explore-kimi ~/Dev/myapp -b kimi -p "explore alternative API designs"

# Local privacy session, slower but no data leaves the laptop
cctabs new private-refactor ~/Dev/clientwork -b qwen-next-local -W

# Compare two models on the same task in parallel
cctabs new task-anthropic ~/Dev/myapp -p "implement spec X"
cctabs new task-kimi ~/Dev/myapp -b kimi -p "implement spec X"

# Custom local Ollama tag not in built-in presets:
cctabs new x ~/Dev/myapp -b qwen-local -m my-custom-tag:latest
```

### Caveats

- **Local backends are slow on M1.** A Claude Code turn against the local 50k-token system prompt takes ~100s prefill + generation on M1 Max. Only worth it for non-time-sensitive private work.
- **Llama 3.1 8B garbles tool calls** under Claude Code's system prompt. Capability gate, not a bug.
- **Ollama Cloud Pro requires `ollama signin`** (one-time). Free tier denies cloud-tagged models.
- **Backend carries into child tabs.** Each launched tab's claude process gets `CCTABS_ACTIVE_BACKEND=<name>`, so a `new`/`resume`/`fork` run from *inside* that session defaults `-b` to the same preset instead of quietly falling back to `anthropic` (your default account). Explicit `-b` still wins, and `-b anthropic` forces the default back. This matters most for account-switching presets (below): a spawned sub-task tab stays on the client's account rather than billing your own.
- **`resume` prefers the account the session actually belongs to.** Sessions live under their preset's `CLAUDE_CONFIG_DIR`, so cctabs knows which account each one came from and resumes it there — ahead of any inherited backend, which would otherwise be whichever account the *calling* tab happened to run under. Precedence: explicit `-b` → the session's own account → inherited. The success line says which (`[backend: client-x (from session)]`).
- **Custom presets** can be added in `~/.config/cctabs/config.toml`. Two forms:
  ```toml
  # Different model/provider — base_url + auth_token shorthand:
  [backends.my-preset]
  model = "qwen3-coder-next:cloud"
  base_url = "http://localhost:11434"
  description = "My custom preset"

  # Fully custom env vars via env_<NAME> — use this for anything not covered
  # by the base_url shorthand, including a different Claude account:
  [backends.client-x]
  description = "Client X's Claude account"
  env_CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-..."
  env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-client-x"
  ```
  `env_<NAME>` sets any env var verbatim on the spawned `claude` process — not limited to the Ollama-oriented fields.

### Running Claude Code as a different account (e.g. a client's or org's subscription)

macOS stores Claude Code's OAuth login in the Keychain as a single global entry per macOS user (service `Claude Code-credentials`, account `<your OS username>`) — it is **not** scoped by `CLAUDE_CONFIG_DIR`. So `CLAUDE_CONFIG_DIR` alone isolates settings/history/MCP config between profiles, but **not** login — two interactive `/login` sessions under different config dirs still fight over the same Keychain slot, and the most recent login wins for both.

The fix: mint a **long-lived OAuth token** for the other account (`claude setup-token`, requires that account to have a Claude subscription) and pass it via `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code's auth precedence honors *before* falling back to the Keychain default — so a tab exporting that token runs as the other account with zero Keychain collision, concurrently with your own default-profile sessions.

One-time bootstrap (the interactive login step must be done by the account owner — an agent cannot drive OAuth):
```bash
# 1. Log into the OTHER account in an isolated profile:
export CLAUDE_CONFIG_DIR=~/.claude-client-x
claude
#   -> /login -> sign in as the other account

# 2. Still in that same shell/profile, mint the long-lived token:
claude setup-token
#   -> prints a token; this is a real credential, handle like a password

# 3. Restore YOUR OWN login in the default profile (step 1 temporarily
#    overwrote the shared Keychain slot):
unset CLAUDE_CONFIG_DIR
claude
#   -> /login -> sign in as yourself again
```
Then add the token to a preset as shown above (`env_CLAUDE_CODE_OAUTH_TOKEN`), `chmod 600 ~/.config/cctabs/config.toml` (it now holds a live credential in plaintext TOML — no dynamic Keychain lookup is supported by the preset loader), and `cctabs new <name> <dir> -b client-x` just works from then on, no further login needed.
