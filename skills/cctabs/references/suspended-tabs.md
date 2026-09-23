# Suspended tabs — `cctabs suspend`, and why `send` wakes them

A **suspended tab** keeps its name, its place in the bar and its Claude session,
but runs no Claude: a small shell placeholder sits in it instead.

```
  ⏸ cctabs suspended — <name> · <transcript size> · <dir>
    press Enter to resume
```

It exists for fleets. Restoring 66 sessions takes minutes, trips the Tabby
plugin's spawn timeouts, and floods claude.ai's remote-control list so the live
sessions fall out of its visible top 20 — when most of those 66 are idle anyway.

```bash
cctabs suspend old-spike other-idea      # stop Claude in each, leave placeholders
cctabs suspend old-spike -c "#6c757d"    # …and grey it while asleep (colour comes back on a cctabs wake)
cctabs restore --manifest fleet.json -c --suspended   # whole fleet back as placeholders: ~1s per tab, no Claude started
cctabs new spike ~/Dev/x -r <session-id> --suspended   # a tab born asleep
cctabs sessions                          # ⏸ suspended — `--json`: status "suspended", session_id + cwd still reported
```

**Waking** — any of these, and the sender never has to know the tab was asleep:

- `cctabs send <tab> …` — wakes it, waits for a READY Claude prompt, then
  delivers and verifies against the transcript. This is the normal path when one
  tab messages another.
- `cctabs wake <tab>` / `cctabs resume <name>` — wake without sending.
- **Enter in the tab** (a human). Resumes in place; the tab keeps any `-c`
  colour until you change it.

A wake answers what stands between the keypress and a usable prompt: the
folder-trust dialog (by locating "Yes" — see the trust gate), the auto-mode
dialog ("Not now"), the resume picker ("Resume full session as-is", never the
summary), the mobile-app overlay. It does **not** answer the MCP-server approval
prompt — that is a security decision — so a wake that meets one fails and says
so instead of stalling.

⚠️ **A suspended tab is NOT on remote control.** It won't appear on claude.ai or
the phone until it is woken. That is half the point — it's what keeps the list
short — but it means a session you want to reach from your phone must be awake.

How the fleet commands treat them:

| Command | Suspended tab |
|---|---|
| `sessions` / `--json` | `status: "suspended"`, with `session_id`, `cwd`, `suspended_at` |
| `manifest` | kept, with `suspended: true` — so restoring from it brings the tab back asleep |
| `restore` | left asleep. `--suspended` makes every restored entry a placeholder |
| `restart` | left asleep, never woken (it picks up the new Claude Code when it next wakes) |
| `close` | closes it and forgets the session's suspended record |

**How cctabs knows** — not from the screen, because Tabby captures nothing for a
background tab whose PTY hasn't attached. In order of trust: the placeholder's
own process (its argv starts `true cctabs-suspended <session-id>`), then the
registry (`~/.config/cctabs/suspended/<session-id>.json`, one file per session),
then the on-screen marker as a last resort. After a Tabby restart a placeholder
can come back with no process at all: `sessions` shows it as **dormant**, and
`send`/`resume`/`wake` put the placeholder back in the same slot before waking
it; `restore` recreates it asleep. Placeholders need bash or zsh as the tab
shell (not fish, not cmd.exe).
