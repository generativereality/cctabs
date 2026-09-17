# Handover — the trust dialog gate in `skills/cctabs/SKILL.md`

Branch: `worktree-cctabs-trust`. Local commits only — **not pushed, no PR**, left for review.

## Why

On 2026-09-16 a driver spawned seven tabs, five as
`cctabs new <name> <dir> --worktree --file <brief>`. All five landed on Claude Code's
trust dialog and **none** received its brief. One brief was consumed by the *shell*
and executed as commands (it began npm-downloading `playwright` and `aws-cdk-lib`)
before that session dropped to a bare prompt.

The skill had nothing on this at spawn time, and two of its statements were actively
wrong for an untrusted directory.

## What changed — `skills/cctabs/SKILL.md` (+110 lines, 2 modified)

| # | Where | Change |
|---|---|---|
| 1 | "When to Use Worktrees", after the ❌/✅ block | The ✅ RIGHT example was broken for a first-time untrusted repo. Added the precondition beside it rather than changing the example — `--worktree` is not the trigger (see below), so the example is fine once the precondition is stated. |
| 2 | New `## The trust gate: what eats a --prompt before Claude ever sees it` | The prevention content: the captured dialog, the `No, exit` default, the one-call Down-then-Enter unblock, the gating rule + table, a read-only pre-spawn check, and the spawn-bare-then-send recipe. |
| 3 | "Workflow: Spawning a Parallel Agent" | "This polls internally until Claude's `❯` prompt appears before sending — **no race condition**" was a false guarantee. Now scoped to the *startup* race, with a ⚠️ stating the poll cannot see `❯` behind the trust dialog. |
| 4 | "When a refusal fires…" (the ⛔ rendered-menu bullet) | Cross-referenced rather than duplicated, and **carved out the trust dialog** from "a human unblocks it": two options with a known starting position is deterministic, unlike the resume picker where a wrong keypress silently accepts a summary. |
| 5 | "Check the installed version isn't stale" | Added the meta-bug: the *skill text* can be the stale half, because the plugin cache and the npm CLI are separate channels. How to detect it and what to do. |

Also `CHANGELOG.md`: two bullets under `## Unreleased`.

## The precondition — what I actually proved

The brief suggested trust might be inherited from any trusted ancestor. **That is not
it**, and a blanket "never `--prompt` with `--worktree`" would also have been wrong.
I read Claude Code 2.1.273's own trust resolver out of the installed binary
(`strings` over `~/.local/share/claude/versions/2.1.273`) and checked the model
against the fleet's recorded state.

**Storage** — `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json`, key
`projects["<abs path>"].hasTrustDialogAccepted`. The binary's own error string
confirms it: *"Run Claude Code interactively here once and accept the trust dialog,
or set projects[…].hasTrustDialogAccepted: true in …"*.

**Match** — neither exact-path nor unbounded-prefix. The resolver walks *up* from the
cwd and returns at the first ancestor marked `true`, **but the walk is bounded by the
enclosing git repo root** and stops there. A separate "advisory" entry point passes a
`null` ceiling for an unbounded walk; the real check does not.

**Worktrees** — the repo root is resolved by parsing a worktree's `.git` pointer file
through `gitdir:` → `commondir`, so it lands on the **main repository**, not the
worktree directory.

Three observations, all consistent with that model and with nothing else I tried:

- This tab: `…/cctabs/.claude/worktrees/cctabs-trust`, **no dialog**. It has no entry
  of its own; its repo root resolves to `~/Dev/generativereality/cctabs`, which is an
  ancestor *and* trusted. Confirmed on disk — the `.git` pointer resolves to
  `…/cctabs/.git`, root `…/cctabs`, and that key reads `True`.
- `~/Dev` was marked trusted on **2026-08-28** and still did not trust the pilot-team
  repos on 09-16 — refutes unbounded ancestor inheritance outright, and is explained
  exactly by the walk stopping at each repo's own root.
- Spot check of the documented one-liner: one never-visited repo → `None` (would be
  gated), one accepted after the incident → `True`.

So the accurate rule, and the one I wrote: **"this path's repo root is already trusted,
in the config dir this tab will use."** The config-dir clause matters here — backend
presets set `env_CLAUDE_CONFIG_DIR`, and the two config files on this machine carry
genuinely different trust sets.

⚠️ **Not fully proven.** I could not run the decisive live probe — launching `claude`
in a scratch directory was refused by the auto-mode classifier as self-modification —
so the model is *read from the shipped resolver plus consistent with three field
observations*, not black-box confirmed. It is also version-pinned: 2.1.273. If it ever
stops matching, the doc's pre-spawn check still gives the right answer for the common
case, because it reads the same key the resolver reads.

## What I chose NOT to change

- **The ❌/✅ worktree example** — left as-is with a precondition beside it. Rewriting it
  to drop `--prompt` would teach the wrong lesson: for a trusted repo those lines are
  correct and are the ergonomic path.
- **Version / plugin.json** — not bumped. Convention checked: the previous doc-only
  commit (`1904558 docs(skill): how a driver decides WHICH tab gets a message`) touched
  `CHANGELOG.md` + `SKILL.md` only, no version bump. `CLAUDE.md` puts the bump in the
  *release* flow, not in each change. So I added `## Unreleased` bullets and stopped
  there. **Whoever releases this should note it is a `SKILL.md` change** — per
  `CLAUDE.md`, the skill ships in both the npm tarball and the marketplace, so it needs
  `npm run sync-plugin` at release time to actually reach the driver that hit this.
- **`src/`** — no code changed. See the proposal below.
- **Existing stuck-tab guidance** — cross-referenced, not duplicated; only the "a human
  unblocks it" clause was narrowed.

## Proposal (NOT implemented): make `cctabs new` refuse rather than mislead

Docs cannot fix this for a driver reading a stale cached skill — which is exactly the
driver that got hurt. The CLI is the channel that was current (0.5.3).

Suggested, in `cctabs new` when `--prompt`/`--file` is given:

1. Resolve the target's repo root (`git rev-parse --path-format=absolute
   --git-common-dir`, strip `/.git`; fall back to the dir itself).
2. Read `projects[<root>].hasTrustDialogAccepted` from `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json`.
   `src/core/config-dirs.ts` already enumerates config dirs and already carries the
   backend→config-dir inference this needs.
3. If not `true`, **refuse before spawning**, naming the path and printing both the
   `printf '\033[B' | cctabs send <tab>` unblock and the bare-spawn alternative.

Refuse, don't auto-drive: answering a trust prompt on the user's behalf is the one
decision that dialog exists to ask, and cctabs should not make it silently. A
`--assume-trusted` escape hatch would keep scripted fleet spawns working.

Read-only, no plugin capability needed, no Tabby-side change. I did not implement it:
it touches the spawn path, the deliverable here is the doc fix, and the detection is
version-pinned to a resolver I read rather than a documented contract — it deserves its
own review and a test, not a ride-along.
