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
  fragment sends something that reads as a complete message. The text is left in
  the input box instead, and the command exits non-zero.
- `--verify` **compares what the session received** against what was sent, via
  the target's transcript — the only reliable completeness check there is.
- It **refuses payloads over 1 KB into a tab with a turn in flight** (`--force`
  overrides). Short replies into a busy tab still work — that's what they're
  for.
- `--wait-for-prompt` reads the whole tail of the buffer, not just its last
  line, so a `Restart to update` banner rendered *below* a ready prompt no
  longer makes it time out.

⛔ **Text containing `--` needs the `--` terminator.** The option parser drops
any argv element containing a double dash, so a message that *quotes a flag
name* — the normal case when one session reports a tool bug to another — used to
vanish silently while `send` printed a ✔. `send` now recovers its positionals
from the raw command line, so this works either way, but the terminator is the
unambiguous form and the only one for text that is *entirely* flag-shaped:

```bash
cctabs send auth -- --verify is broken and --path too
```

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
