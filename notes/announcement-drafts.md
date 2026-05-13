# cctabs 0.3.1 + Tabby support — announcement drafts

Three posts, ready to copy-paste. Tweak as needed before posting.

---

## 1. Tabby GitHub Discussions (Show & tell / General)

> **URL:** https://github.com/Eugeny/tabby/discussions/new?category=show-and-tell
> Pick category **"Show & tell"** if available, otherwise **"General"**.

**Title:** `cctabs — run a fleet of Claude Code sessions across Tabby tabs`

**Body:**

```markdown
Hi Tabby folks 👋

I built **cctabs**, a small companion plugin + CLI that turns Tabby tabs into
the unit of orchestration for [Claude Code](https://claude.ai/code) sessions.

The idea: when you're running multiple Claude Code sessions in parallel
(auth, api, frontend, infra…), you lose track fast. Which tab is doing what?
Did it finish? cctabs gives every Claude session a named tab and a
CLI you can drive — `cctabs new`, `fork`, `send`, `sessions`, `scrollback`,
`restore` — so Tabby's own tab bar becomes the dashboard. No tmux, no TUI.

The Tabby plugin (`tabby-cctabs`) exposes a tiny local HTTP API at
`127.0.0.1:3300` that the CLI uses to drive tabs. Install it from
**Settings → Plugins** → search "cctabs" → install → restart Tabby.

The killer feature: Claude can drive cctabs *itself* (there's a Claude Code
skill that ships with it), so you can say "spawn three sibling tabs working on
X, Y, Z" and it does — without you switching tabs.

- Website / docs: https://cctabs.com
- Changelog: https://cctabs.com/changelog
- Plugin on npm: https://www.npmjs.com/package/tabby-cctabs
- CLI on npm: https://www.npmjs.com/package/@generativereality/cctabs
- Source (CLI + plugin in one repo): https://github.com/generativereality/cctabs

Tabby is a first-class supported backend alongside Wave Terminal. Feedback
welcome — especially anything that feels off in the plugin UX (settings,
discovery, restart flow).
```

---

## 2. Reddit r/ClaudeAI

> **URL:** https://www.reddit.com/r/ClaudeAI/submit
> Choose **Post type: Link** or **Text** — text gives more room to explain.

**Title:** `cctabs — let Claude Code spawn its own parallel sessions, each in a named terminal tab`

**Body (text post):**

```markdown
Most folks running multiple Claude Code sessions hit the same wall around 3–4
tabs: you stop knowing which tab is doing what, which finished, which is
waiting for input.

**cctabs** flips that around. It's a tiny CLI + Claude Code plugin that treats
your terminal tabs as the orchestration surface:

```bash
cctabs new auth ~/Dev/myapp       # named tab, Claude starts
cctabs new api ~/Dev/myapp
cctabs sessions                   # what's running across all tabs
cctabs scrollback auth            # read another tab without switching
cctabs send api --file task.txt   # drop a prompt into a session
cctabs fork auth -n auth-v2       # branch a conversation
cctabs restore                    # reopen everything after a reboot
```

The bigger win: there's a **Claude Code skill** that ships with it, so you can
tell *Claude itself* to spawn sibling sessions, monitor their output, and
coordinate across tabs. Going from 4 sessions to 10–15 stops being painful.

Works with **Wave Terminal** and (new in 0.3.x) **Tabby**.

Install (one step, inside a Claude Code session):

```
/plugin marketplace add generativereality/plugins
/plugin install cctabs@generativereality
```

- Website: https://cctabs.com
- Changelog (lots of recent updates): https://cctabs.com/changelog
- Source: https://github.com/generativereality/cctabs

Curious what people are using to manage parallel Claude Code sessions today —
tmux, multiple windows, raw `claude --resume`, something else?
```

---

## 3. Reddit r/commandline

> **URL:** https://www.reddit.com/r/commandline/submit

**Title:** `cctabs — terminal-tab-native session manager for parallel Claude Code (Wave + Tabby)`

**Body (text post):**

```markdown
I've been building this in the open for a couple of months and Tabby support
just landed, so figured I'd share.

**cctabs** is a CLI that uses terminal tabs as the unit of orchestration for
[Claude Code](https://claude.ai/code) sessions. No tmux, no TUI, no dashboard
— your terminal's tab bar IS the UI. Each tab has a name, a working
directory, and one Claude session pinned to it. The CLI keeps tab title,
session name, and cwd in sync.

```sh
cctabs new auth ~/Dev/myapp        # new tab, Claude starts
cctabs new api ~/Dev/myapp
cctabs sessions                    # list every tab + state (idle/active)
cctabs scrollback auth             # read another tab without switching
cctabs send api --file task.txt    # send a prompt into a session
cctabs fork auth -n auth-v2        # branch a conversation
cctabs restore                     # reopen everything after a reboot
```

Backends are pluggable: Wave Terminal first, **Tabby** as of v0.3.x. Tabby
support ships as a companion plugin (`tabby-cctabs`) installable from Tabby's
own plugin browser.

There's also a Claude Code skill so Claude can drive cctabs itself — useful
when you want one Claude session to coordinate work across several siblings.

- Site: https://cctabs.com
- Changelog: https://cctabs.com/changelog
- Source: https://github.com/generativereality/cctabs (MIT)
- CLI on npm: `@generativereality/cctabs`
- Tabby plugin on npm: `tabby-cctabs`

Happy to answer questions on the architecture (especially the
tab↔session↔cwd identity bits, which were the tricky part).
```

---

## 4. Posting checklist

- [ ] Verify https://cctabs.com/changelog is live (deploy first if not)
- [ ] Sanity-check `tabby-cctabs@0.1.1` appears when searching "cctabs" in Tabby → Settings → Plugins (may take a few minutes for npm search-index refresh)
- [ ] Post Tabby Discussions first (smaller audience, friendlier — surfaces any objections before going wide)
- [ ] Then r/ClaudeAI
- [ ] Then r/commandline (typically more skeptical — leading with the working code helps)
- [ ] Skip r/programming / Hacker News for now; come back if the first three land well

## Optional follow-ups

- X / BlueSky thread (3–4 short posts: the problem → the fix → "Claude can drive it" → install line)
- Dev.to / personal blog post — long-form architecture (cctabs' tab/session/cwd identity, scrollback parsing, restore manifests)
- Demo video / GIF on the website hero section — currently text-only; a 20s loop of `cctabs sessions` + Claude spawning a tab would be striking
