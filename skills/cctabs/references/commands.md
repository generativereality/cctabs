# Every cctabs command, one line each

`cctabs <cmd> --help` is the authority on flags: when this list and the binary disagree, trust the binary.


```bash
cctabs sessions                          # list all tabs with session status
cctabs list                              # list all workspaces, tabs, and blocks
cctabs new <name> [dir] [-w workspace] [-p "prompt"] [-f file]  # new tab; inherits caller’s engine (else Claude)
cctabs new <name> [dir] --path <file>    # new tab handed a file PATH to read — same handoff as `send --path`, no short flag (`-p` is --prompt here)
cctabs new <name> [dir] -b <preset>      # new tab on another backend / Claude account
cctabs account add <name>                # add another Claude account: the user signs in, in the tab it opens
cctabs new <name> [dir] -c <colour>      # new tab, coloured (also -c on resume/fork)
cctabs resume <name> [dir] [-s session]  # resume last session (reuses tab or creates one; picks the session's own account)
cctabs restore [dir] [--dry]             # resume every empty tab by name search (e.g. after a reboot)
cctabs restore --manifest <file|-> [-c] [--dry]  # resume from an explicit {name,dir,session_id,backend?} list — accepts `cctabs sessions --json` directly
cctabs manifest [-o file] [--repoint-missing-dirs <dir>]  # snapshot the fleet as a VALIDATED manifest: one entry per session id, this session left out, dirs + transcripts checked
cctabs restart [--all | --only a,b] [--dry]      # restart Claude in every tab (new Claude Code version): snapshot → stop → restore → audit. Bare = plan only
cctabs restart-tabby [--yes]              # restart TABBY without losing tabs: save all → close → quit+reopen → restore in a new tab
cctabs prepare-reboot [--yes]             # before restarting the computer: save all + close; afterwards `cctabs restore --pending`
cctabs suspend <tab> [<tab>…] [-c <colour>]  # stop Claude, leave a placeholder that knows its session (NOT on remote control until woken)
cctabs wake <tab>                        # wake a suspended tab, wait for a READY prompt (so do `resume <name>`, Enter, or just `send`)
cctabs restore --manifest <file> -c --suspended   # bring a whole fleet back as placeholders, in seconds
cctabs restore --manifest <file> -c --suspend-older-than 3d   # one run: recent sessions running, quieter ones asleep — new tabs go after the existing bar, in manifest order
cctabs fork <tab-name> [-n new-name]     # fork source engine’s session into new tab
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # tab title + live claude/RC name + on-disk customTitle, so the name survives a restart — see references/tabs.md
cctabs color <name-or-id> <colour>       # set/clear the tab colour: blue|green|orange|purple|red|yellow|none|#rrggbb
cctabs whoami [--json]                   # which tab is THIS session in? prints the tab name, or "unknown"
cctabs sort [--dry] [--reverse]          # reorder the tab bar by session activity, newest first (Tabby only)
cctabs sort --first a,b,c [--dry]        # PIN these tabs to the front, in this order; everything else keeps its relative order
cctabs scrollback <tab-or-block> [n]    # read terminal output — the last PAINTED FRAME (default: 50 lines)
cctabs transcript <tab> [n] [--json]    # read what a tab has SAID: its last n assistant messages, from the transcript (alias: `findings`)
cctabs new <name> [dir] --engine codex [--prompt …]   # Codex; session discovery, manifest restore and --suspended work — see references/codex.md
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs send <tab> --path <file>          # hand the tab a file PATH to read — the safe way to deliver anything large
cctabs send <tab> --file <f> --verify    # check the target's transcript for what it actually RECEIVED
cctabs send <tab> --submit               # press Enter only, submitting a prompt already parked in the box
cctabs send <tab> "…" --allow-draft      # type even though the box holds an unsent draft (default: wait ≤60s, then refuse)
cctabs send <tab> -- <free text>         # only for text that is ONE bare flag-shaped word (`--push`); "run it with --push" needs nothing
cctabs export <name> [--out path]        # bundle a tab + its claude session into a tarball
cctabs export --all [-w workspace]       # bundle every tab in a workspace
cctabs import <tarball> [--dry-run] [-f] # restore tabs + sessions from a tarball
cctabs profile-copy <tab|session-id> --to <preset> [-n name] [--move] [--dry]  # copy/move a session into another Claude account
cctabs backends                          # list available backend presets
cctabs config                            # show config and path
```
