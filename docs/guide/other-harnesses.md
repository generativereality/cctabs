---
title: Try opencode, pi and Hermes without leaving Claude Code — cctabs
description: cctabs 0.8.0 lets Claude open opencode, pi, oh-my-pi, Hermes Agent and Grok Build in named tabs next to its own, with a first prompt, and read back what they answered.
---

# Try opencode, pi and Hermes without leaving Claude Code

I heard some people liked opencode and pi and wanted to try them out, but it was kind of high friction to do so. I keep a lot of Claude Code sessions open, and setting up another harness on the side was enough to put it off. So I thought it would be easy if I could just ask Claude to open new sessions in those two.

cctabs 0.8.0 does that. You tell Claude something like "open an opencode tab in this repo and ask it to look at the failing test", and it opens a named tab running opencode, with your request as its first prompt. The same works for pi, oh-my-pi, Hermes Agent and Grok Build:

```bash
cctabs new fix-test --engine opencode --prompt "look at the failing test"
cctabs new --engine pi
cctabs new --engine omp
cctabs new --engine hermes
cctabs new --engine grok
```

If a harness isn't installed, cctabs says so and shows its install line. For pi, oh-my-pi and opencode, `cctabs transcript <tab>` reads back what the other harness said, so the Claude that opened the tab can see the answer without you copying it over.

I don't hand anything to them yet myself. I'm just trying new things and evaluating them at this point. But I want to make it easier for others to also try other harnesses. If you use one of these and something is missing, open an issue: https://github.com/generativereality/cctabs/issues
