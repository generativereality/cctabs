---
title: Privacy — cctabs
description: What cctabs reads, where it sends it, and what it keeps. It runs on your computer and has no server.
---

# Privacy

cctabs runs on your computer and has no server. The CLI talks to its Tabby plugin on 127.0.0.1, and
reads the transcripts of your own Claude Code and Codex sessions on this computer, only when you
or Claude ask what one of your tabs said. What
it shows Claude goes to the AI provider you use, under its terms, like anything else in your
conversation. Over the internet it only talks to npm's registry: to install the CLI and the Tabby
plugin when you say yes, and to tell you when a newer version is out.
