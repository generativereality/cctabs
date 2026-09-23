# Routing: deciding WHICH tab gets a message

> Read before relaying findings, meeting notes or any message to another tab in a fleet — the three gates below decide whether to send at all, and to whom.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

The send mechanics will tell you whether text arrived. They cannot tell you
whether it should have been sent, to that tab, at all. Three gates, in order —
they are cheap, and each one has caught a real mis-send on a live fleet.

## 1. Resolve the owner from the BRANCH, not the tab's name

Tab names drift from scope as work moves; branches do not. Measured on a
92-tab fleet, all three layers disagreed:

| tab name | worktree dir | branch (the authority) |
| --- | --- | --- |
| `report-q3` | `parser-limits` | `docs/report-q3-capacity-findings` |
| `cache-latency` | `cache-latency` | `fix/audit-table-per-row-scan` |
| `probe-8842` | `probe-8842` | `fix/invalid-address-and-coupon-reset` |

(Shapes from a real fleet, names replaced.) Read the last row: **the owner of
"coupon" work is a tab called `probe-8842`**, and no tab on that fleet was named
anything like "coupon". A name-based router finds nothing and picks whatever
sounds adjacent — which is how a tab that owned a quarterly report was once sent
pricing material belonging to a different worktree.

```bash
cctabs sessions --json | jq -r '.workspaces[].sessions[] | "\(.name)\t\(.cwd)"'
git -C <repo> worktree list --porcelain     # cwd -> branch
gh pr list --search <topic>                 # branch -> the PRs that own it
```

- ⛔ **If no tab maps to the owning branch, the finding has no home in the
  fleet. Say so — send nothing.** "Closest available tab" is not a routing
  decision.
- ⚠️ `cctabs sessions` has **no `--all` flag**. Unknown flags are silently
  ignored, so `--all` looks like it worked while doing nothing. `--json` is the
  whole interface.
- ⚠️ **This gate answers for a minority of tabs, and that's fine.** On the same
  fleet: 22 of 92 tabs sat on a topic branch (resolvable this way), 43 sat on
  `main` in the repo root (the branch says nothing about ownership), and 27 were
  in other repos. When the branch is `main`, skip to gate 2 rather than
  inventing a mapping.

## 2. Count what the tab ALREADY KNOWS before drafting

`cctabs transcript` shows what a tab *concluded*. That is not the same as what
it has *seen* — and a message telling a tab what it already knows costs it a
cycle to read and teaches it nothing. So count the specific phrases you are
about to relay, in the tab's own transcript:

```bash
F=$(cctabs transcript <tab> --json | jq -r .transcript)   # exact path, right account
for phrase in "42,000" "Northwind" "onboarding reminder"; do
  printf '%-24s %s\n' "$phrase" "$(grep -o -i -- "$phrase" "$F" | wc -l)"
done
```

Resolve the path through `transcript --json` rather than globbing
`~/.claude*/projects/*`: it picks the right session id *and* the right Claude
config dir, which a glob gets wrong as soon as the tab runs under a backend
preset.

Measured — one message, six candidate tabs:

| tab | already knew | genuinely new |
| --- | --- | --- |
| tab A | `<subsystem>` ×453, `<owner>` ×1265, `<artefact>` ×114 | nothing → **dropped** |
| tab B | `<environment>` ×70, `42,000` ×2 | `first 500` ×0, `onboarding reminder` ×0 |
| tab C | `Northwind` ×75, `0.07` ×29 | `<the meeting's conclusion>` ×0 |

One of six had nothing new and was dropped. (Counts are real; the terms they
were counted on are replaced — see the note at the end of this section.)

- **The signal is zero vs non-zero, not the magnitude.** A count of 453 and a
  count of 70 mean the same thing: it knows. Only ×0 earns a place in the draft.
- **Count short distinctive tokens** — names, figures, product names — not
  sentences. The transcript is JSON-escaped, so a phrase spanning a newline
  won't match and you'll read a false ×0.

## 3. Relay what was SAID — not your conclusions

Turning transcript statements into directives ("re-aim to…", "do X before Y")
is the most common bad draft. Quote the speaker, attribute it, and leave the
inference to the receiver. Two reasons: the tab has context the driver does not,
and **a quoted statement is checkable while a paraphrased instruction is not.**

⭐ **When a statement CONTRADICTS what the tab concluded, that is the
highest-value relay there is — send it, flagged as a contradiction.** One tab had
concluded, from four signatures, that a suspected cause was ruled out, while the
meeting concluded the opposite. It needs both, and it needs to know they
disagree; it does not need to be told which to believe.

> **A note on the examples above.** They come from real fleets driven against
> private repositories, so every branch name, tab name, company, person and
> figure has been replaced with a synthetic stand-in; only the shapes, ratios and
> counts are real. Do the same in anything you write out of a fleet — a routing
> note, a PR body, a commit message, an issue. Tab names and branch names are
> the two that leak most easily, because they read like infrastructure rather
> than like the customer work they describe.
