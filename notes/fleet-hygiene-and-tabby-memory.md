# Fleet hygiene, and the Tabby helper that eats the machine

Brief written 2026-09-17 by the `rtmtatysclerk` tab in the `rememberthis.ai`
repo, at Fred's request, after this killed a real release build.

Fred: *"some reliable ways of analyzing which cctabs are likely inactive and can
be 'paused' eg closed / shelved but written down as such rather than forgotten —
and/or just suggest close all tabs and restart tabby when tabby helper grows too
high, or ideally actually find the root cause and fix it."*

⚠️ **Written against `origin/main` at v0.5.4, after a first draft that asked for
things v0.5.4 had already built.** Read the changelog before acting on any of
it; this note is a photograph.

## What happened, measured rather than remembered

A four-brand Windows release build was killed partway through the third brand.
The harness said only:

> *stopped because the system is running low on memory*

That names the symptom and not the cause, and the natural reading is that the
build was too heavy. **It was not** — the same build had succeeded twice on the
same machine in the preceding half hour. From `top -l 1 -o mem`:

| process | real footprint |
|---|---|
| `Tabby Helper (GPU)` | **40 GB** |
| `qemu-system-aarch64` | 16 GB |
| `Tabby Helper (Renderer)` | 2.4 GB |

The consuming repo's `CLAUDE.md` records this helper at **25 GB** and later
**35 GB** on earlier days. 25 → 35 → 40 is a leak with a slope, and every
session on the machine is downstream of it.

## ⛔ Before building any memory check: `ps -o rss` IS OUT BY 300× HERE

The trap that would silently make a memory feature useless. Three instruments,
one process:

| instrument | Tabby Helper (GPU) |
|---|---|
| `ps -o rss` | **79 MB** |
| `top -l 2 -o mem` | 25 G |
| `sudo footprint -p <pid>` | **`phys_footprint: 25 GB`** |

Under pressure most of a large process's pages are compressed or swapped out and
`rss` counts only the resident ones — so it is blind in exactly the case worth
detecting. **`footprint` is the arbiter; `top -l 2 -o mem` agrees with it.** A
check built on `ps` reports 79 MB and never fires.

⚠️ **Swap `used` is residue, not pressure** — `sysctl vm.swapusage` stays
alarming for hours after the problem clears. What moves is the pageout *rate*:

```sh
A=$(vm_stat | awk '/Pageouts/{print $NF}' | tr -d '.'); sleep 20
B=$(vm_stat | awk '/Pageouts/{print $NF}' | tr -d '.'); echo $((B-A))
```

## Part 1 — which tabs are actually dead

**v0.5.4 already supplies the raw signals**, and this is the part of the first
draft that was wrong: `sessions --json` (with `session_lookup` distinguishing
*not-found* from *lookup-failed*) and `transcript <tab>` (what a tab has SAID,
not what it is painting) are exactly the inputs this needs. What is still
missing is a verb that answers the question.

⭐ **The signal is the session transcript's mtime.** `sessions` reports
`active` / `idle (waiting for input)` / `terminal`, and a tab idle for three
weeks reads identically to one idle for three minutes.

Sketch, building on what exists:

- **`cctabs stale [--days N]`** — tabs whose transcript has not moved in N days,
  with directory, last activity, transcript size. The inventory nobody has.
- **`cctabs shelve <tab>`** — record `{name, cwd, session id, last activity,
  and enough of what it was doing to know why}` to a file, *then* close.
  `transcript <tab> 1` is a good source for that last field.
- **`cctabs unshelve <name>`** — recreate and `--resume`.

Two properties that decide whether it is worth anything:

1. **The record must be a file, not scrollback.** The consuming repo's rule:
   *a request that exists only inside somebody's terminal scrollback is not
   recoverable by a fresh session.* A shelved tab whose purpose is unwritten is
   just a closed tab.
2. **Shelving must be reversible**, which it nearly already is — `resume` and
   `restore` do the hard half. Shelve is mostly *record, then close*.

⚠️ **A name is not a purpose.** `clerk-icp`, `fourth-app`, `money-act` tell you
nothing a week later.

⚠️ **Do not infer "safe to close" from idleness.** A tab can be idle because it
waits on a human, a build, or another tab. Report evidence; let a person decide.
An automatic reaper on this fleet would close somebody's in-flight release.

## Part 2 — the suggestion, when it is already too late

Cheap and worth having without a root cause: **`cctabs doctor` should read the
helper's real footprint and say so**, with the number and what it costs —

> `Tabby Helper (GPU) is at 40 GB (footprint). Tabs: 65. Background tasks on
> this machine are being killed for memory. Restarting Tabby clears it and
> closes every tab — 'cctabs stale' first.`

⛔ **Suggest, never act.** Restarting Tabby takes every tab with it, including
other people's in-flight work.

⇒ And the rule regardless of what gets built: **when a background task is killed
for memory, read `top -l 1 -o mem` BEFORE re-running it smaller.** Today the
obvious move was to shrink the build, and it would have been wrong.

## Part 3 — the root cause, which is NOT established

Hypotheses with the check that settles each. **None has been measured.** A
mechanism is not established by evidence that it *could* work.

1. **Scale, not a leak.** ~65 tabs, each a terminal renderer, one shared GPU
   process. *Check:* footprint against tab count — close 20 and see whether it
   falls. If it does, it is occupancy and Part 1 is the whole fix.
2. **Scrollback retention.** *Check:* whether footprint tracks total scrollback
   lines, and whether lowering Tabby's scrollback limit moves it.
3. **The WebGL renderer.** xterm.js's WebGL addon keeps glyph atlases on the
   GPU, which is what a GPU helper's memory *is*. *Check:* whether Tabby uses
   it, and whether the canvas/DOM renderer changes the slope.
4. **A genuine leak with no ceiling.** *Check:* footprint over time on a single
   idle tab with no output.

⇒ **Run 4 first.** Cheapest, and it discriminates hardest: a flat line on an
idle instance rules out a leak and sends you to 1–3; a rising one makes 1–3
irrelevant.

## What this session got wrong, which is evidence about the tool

- ⭐ **Two `cctabs send` calls reported `✔ Sent to <id>:` with an empty preview
  and delivered nothing** — confirmed at the receiver, which never saw the text
  and never went active. **Both message bodies contained a literal `--`.** That
  is precisely v0.5.4's *"the option parser silently drops any argv element
  containing `--`"*, and this machine runs **0.5.2**. So the cause is known and
  fixed; what it cost here is that a stand-down message to a duplicated tab
  never arrived and the tab had to be closed instead.
  ⇒ **The fleet is on 0.5.2 and the fix is in 0.5.4.** Upgrading the machines is
  the action item, not a code change.
- ⚠️ **The first draft of this note claimed `sessions` had no structured
  output. That was false** — `--json` exists and works in 0.5.2. The real
  failure was mine: I read the *human* output and piped it through `head -60`,
  on a fleet whose listing is 199 lines, concluded a tab did not exist, and
  spawned a duplicate onto work another tab was already doing. An absence read
  off a truncated list, which is the same class as `ps -o rss` above.
  ⇒ There is still something cheap here: **`sessions` could take a `--name`
  filter**, so the natural one-tab question needs no piping at all.
- **Two tabs can share a name**, after which `scrollback <name>` refuses with
  *"Multiple tabs match"*. The refusal is right; what is missing is anything
  that warns at **creation** time, which is when it is still free to fix.
