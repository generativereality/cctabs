# Sending input to a session

> Read when sending anything beyond a short reply: the full `send` forms, what it refuses and why, the `--` terminator, and what to do when a refusal fires.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Workflow: Sending Input to a Session

```bash
cctabs send auth "yes\n"        # approve a tool call
cctabs send auth "\n"           # press enter (confirm a prompt)
cctabs send auth --submit       # press Enter only — submits a prompt already parked in the box
cctabs send auth "/clear\n"     # send a slash command
cctabs send auth --path ~/prompts/task.txt   # hand over a path — the safe way for anything large
cctabs send auth --file ~/prompts/task.txt   # paste the contents (short payloads only, see SKILL.md)
echo "do the thing" | cctabs send auth       # pipe via stdin
```

⭐ **`send` to a suspended tab just works.** It wakes the tab, waits for Claude
to reach a ready prompt (answering the folder-trust dialog and the resume picker
on the way), delivers, and checks the delivery against the session's transcript.
See [suspended-tabs.md](suspended-tabs.md).

**What `send` now refuses to do, and why it matters when driving a fleet:**

- It **distinguishes three claims that used to be one ✔ line**: nothing arrived
  (a hard failure), something arrived but completeness is unverified (a
  warning), and verified. "Sent" and "arrived whole" are not the same fact.
- It **will not submit a body that did not land at all.** Pressing Enter on a
  fragment sends something that reads as a complete message. It exits non-zero
  instead, and takes its own text back out of the box (below).
- It **checks that Enter submitted** (0.6.3+): the input box must empty after
  Enter. An Enter can be swallowed, and before 0.6.3 `send` printed `✔ Sent` on
  the strength of the text having landed — mmm-dev's message to clerk-dev did
  exactly that on 2026-10-17 and sat unsubmitted in clerk-dev's box for hours,
  where every later send refused on it as a draft. Now a box still holding the
  text gets up to three more Enters, and if none takes, `send` exits 1.
- It **doesn't leave its own text behind** (0.6.3+). When a send can't submit
  what it typed, and the box was empty before it typed, it clears the text
  (Ctrl-U) and says so: abandoned text is indistinguishable from someone's
  draft and blocks the next sender. If the box already held something, nothing
  is cleared and the message says so.
- `--verify` **compares what the session received** against what was sent, via
  the target's transcript — the only reliable completeness check there is.
- It **won't type into someone's unsent draft.** If the input box already holds
  text — a person half-way through writing, or a prompt parked there — `send`
  would add its text to the end and submit both, and a retry's Ctrl-U would wipe
  the draft. So it waits for the box to clear, re-checking at 1s, 2s, 4s … (capped
  at 16s), for up to `--draft-wait` seconds (default 60), then refuses with exit 1
  and quotes the draft. Treat that refusal as "a human is using this tab": try
  later rather than forcing — unless the quoted draft is plainly another agent's
  message to that tab (`From mmm-dev: …`), stranded by an older cctabs; then
  `--allow-draft` delivers yours behind it, or `--submit` sends it. `--allow-draft` types into it anyway; `--submit` is
  exempt, since submitting what's parked is its job. `cctabs rename` waits the
  same way before typing `/rename`. Needs the Tabby plugin's `screen` capability
  (tabby-cctabs ≥ 0.1.6): it reads the tab's screen, because the output stream
  can't show what's in the box. With an older plugin, or a tab that has never
  been shown, `send` can't see the box and types as before.
- `--no-enter` leaves the text in the input box unsent. (Before 0.5.11 there
  was no way to turn the Enter off: `--enter=false` and `--no-enter` both read
  as "on".)
- It **refuses payloads over 1 KB into a tab with a turn in flight** (`--force`
  overrides). Short replies into a busy tab still work — that's what they're
  for.
- `--wait-for-prompt` reads the whole tail of the buffer, not just its last
  line, so a `Restart to update` banner rendered *below* a ready prompt no
  longer makes it time out.

**Text containing `--` is text** (0.6.3+). The tokenizer under cctabs' option
parser takes any argv element with `--` *anywhere* in it for an option, so a
message that quotes a flag — the normal case when one session reports a tool bug
to another — was first eaten silently, then (0.5.x–0.6.2) refused with `… is not
an option of cctabs send. Nothing was run.`, and `new --prompt "… --push …"`
failed with `Optional argument '--prompt' … should be 'string'`. Now only an
element *shaped* like an option (`--name`, `--name=value`, `-x`) is one; any
other text is text, including text that starts with `--`:

```bash
cctabs send auth "run publish.sh --push to ship"      # fine
cctabs send auth "--verify is broken and --path too"  # fine: not shaped like one option
cctabs send auth -- --push                            # a lone flag-shaped word needs the terminator
```

**Every refusal ends the output with one line, `ERROR  NOT SENT to "<tab>" (<id>): …`,
and exits 1.** Read the last line (and the exit code, which a `| tail` hides).
Before 0.6.3 the error was followed by a blank line, so `cctabs send … 2>&1 |
tail -1` printed nothing at all — neither ✔ nor ERROR — and an agent sent into a
refusing tab for hours.

An empty body is now a **hard error**, not a ✔ — so a swallowed payload fails
loudly instead of pressing Enter and claiming success. A deliberate bare Enter
(`--submit`, or a literal `""`) reports itself as `Submitted Enter only (no
body)`.

⚠️ **`--path` makes the receiving session READ the file, so the file's contents
appear in its transcript as a tool result.** That is the handoff working — not a
paste. (`--verify` knows the difference: it skips tool results and searches all
of the session's real messages, not just the newest.)

### When a refusal fires, the refusal is usually right

Both of these have fired on a live fleet and been correct every time. Neither is
a case for `--force`.

- ⛔ **`nothing from the text appeared in the tab` means the tab is on a
  RENDERED MENU, and it is unreachable — escalate to a human.** A tab sitting on
  the trust dialog, the resume picker or a permission prompt swallows pasted text
  into the menu, so the send genuinely delivered nothing and correctly refused to
  submit. **Do not retry with `--path`**: the handoff is text through the same
  prompt line and is eaten the same way. Do not drive the menu blind either —
  `cctabs scrollback <tab>` shows which menu it is, and the wrong keypress in the
  resume picker silently accepts a summary instead of the session (see the
  restore section in [restore-and-restart.md](restore-and-restart.md)). For the resume picker and permission prompts, a human
  unblocks it; a driver reports it. **The trust dialog is the one exception** —
  two options with the marker parked on `No, exit`, so
  `printf '\033[B' | cctabs send <tab>` is deterministic rather than a guess. Best
  of all, don't arrive here: the gate is preventable at spawn time, see **"The
  trust gate"** in [SKILL.md](../SKILL.md).
- ⚠️ **The 1 KB busy-tab refusal means shorten the message, not force it
  through.** It fired twice in one day of driving and shortening was the right
  response both times — a multi-kilobyte brief aimed at a tab mid-turn is nearly
  always a routing or timing mistake, which is what the gates in [routing.md](routing.md) are for.

## Did a big paste arrive whole?

⚠️ **The screen cannot tell you whether a big paste arrived whole.** Claude
collapses it into a `[Pasted text #N +M lines]` chip, and `M` does **not** track
the payload: a 6,892-byte, 76-line payload was measured arriving *complete* into
an idle tab while its chip read `+10 lines`. So `send` reports "arrived,
completeness unverified" rather than a ✔, and if you need certainty add
`--verify` — it reads the target session's own transcript, which records what it
actually received, and fails loudly naming which end went missing.

```bash
cctabs send payments --path /tmp/brief.txt --verify   # belt and braces for a brief that matters
```
