# cctabs

**Run many Claude Code and Codex sessions in your own terminal tabs, and let Claude keep track of
them.**

Around ten sessions you can still juggle by hand. Past that you stop knowing which tab is doing
what. I usually have more than fifty open: each sits in its own named terminal tab, and the Claude
I am talking to opens, reads, prompts and forks the others itself. Mostly you just ask it:

- *"With cctabs, open tabs api and ui and give each its task."* Two named tabs appear in the bar
  and start working.
- *"What is the api tab doing?"* Claude reads its output and tells you, without switching tabs.
- *"Fork api and try the other approach in api-v2."* A third tab opens with api's conversation.
- *"Which tabs are waiting for me?"* Claude lists the ones that are.

Or type the commands yourself:

```
cctabs new api ~/Dev/myapp --prompt "add a /health endpoint"
cctabs sessions                   # every tab: busy, or waiting for you
cctabs scrollback api             # what api is doing, without switching to it
cctabs send api "now add a test"  # give a tab more work
cctabs fork api -n api-v2         # try another approach, the original left as it was
cctabs profile-copy api --to work # carry a Claude session over to your 'work' account
cctabs restart-tabby              # restart the terminal, every tab comes back
cctabs prepare-reboot             # before restarting the computer
```

## What it does that tabs by hand don't

- **Claude drives the fleet.** One plugin install gives Claude Code a skill to use the cctabs CLI:
  it checks what is already running, opens tabs, starts sessions in them, reads their output and
  sends them work, without you relaying anything by hand.
- **Native tabs, not tmux.** Each session is an ordinary tab in your terminal. Your key bindings work, and
  scrolling and copy and paste behave the way they do everywhere else. There is no dashboard to
  live in.
- **Any account, any backend, per tab.** Run one tab on your own Claude account, the next on your
  company's, another on Codex CLI. Out of quota? Move a Claude session to another account and pick
  it up where it left off.
- **Restore after a restart.** `cctabs restart-tabby` saves every session, reopens the terminal and brings
  each tab back, named and in its order. Before restarting the computer, run
  `cctabs prepare-reboot`; afterwards `cctabs restore --pending` brings the fleet back the same way.

## Install

```
/plugin marketplace add generativereality/plugins
/plugin install cctabs@generativereality
```

The plugin works in Claude Code, in a terminal cctabs supports: today that is Tabby, and other
terminals can be added as backends. It does nothing in chat on claude.ai or in Cowork.

The skill installs the `cctabs` CLI from npm (`@generativereality/cctabs`) when you first use it,
and asks before it does. Then, from inside a Tabby tab, `cctabs install-tabby-plugin` downloads the
small Tabby plugin cctabs talks to from npm and restarts Tabby, after asking too.

Using auto mode? Add `"Bash(cctabs:*)"` to `permissions.allow` in your Claude Code settings,
so the tabs Claude opens are not held for auto mode's safety check.

## You need

- A terminal cctabs supports: today [Tabby](https://tabby.sh), on macOS or Windows 11
- Node.js 20.19.4 or later
- Claude Code, and Codex CLI if you use it

## Privacy

cctabs runs on your computer and has no server. The CLI talks to its Tabby plugin on 127.0.0.1, and
reads the transcripts of your own Claude Code and Codex sessions on this computer, only when you
or Claude ask what one of your tabs said. What
it shows Claude goes to the AI provider you use, under its terms, like anything else in your
conversation. Over the internet it only talks to npm's registry: to install the CLI and the Tabby
plugin when you say yes, and to tell you when a newer version is out.

## More

Docs, commands and how it compares with tmux-based session managers: https://cctabs.com
Source and issues: https://github.com/generativereality/cctabs

Made by Fredrik Wollsén (@motin) at Augmented Mind, and published in the generativereality plugin
marketplace. MIT licence.
