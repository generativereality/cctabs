# Moving sessions across machines

> Read when migrating a tab or a workspace, with its Claude conversation, to another machine.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Workflow: Moving sessions across machines

Use `export` + `import` to migrate a tab (or a whole workspace) — and its underlying Claude conversation — from one machine to another, e.g. when switching laptops or sharing a debug session with a teammate.

```bash
# On source machine
cctabs export auth                                  # → ./cctabs-export-auth-<ts>.tar.gz
cctabs export auth --out ~/Downloads/auth.tar.gz
cctabs export --all                                 # every tab in the current workspace
cctabs export --all --workspace tabby

# On destination machine
cctabs import ~/Downloads/auth.tar.gz --dry-run     # preview without copying or opening tabs
cctabs import ~/Downloads/auth.tar.gz               # copy session jsonl(s) + open tab(s)
cctabs import ~/Downloads/auth.tar.gz --cwd ~/Dev/myapp   # single-tab archives only — remap the cwd
cctabs import ~/Downloads/auth.tar.gz --force       # overwrite a session id that already exists locally
```

Gotchas:

- **Target cwd must exist on the destination machine.** Each manifested tab carries the original `cwd` (e.g. `/Users/alice/Dev/myapp`). If that path doesn't exist locally, that entry is skipped with a "clone the repo, then re-run" hint. Either clone/recreate the directory first, or use `--cwd` to remap (single-tab archives only).
- **No multi-tab cwd remap.** If the source laptop had repos under a different layout (e.g. `~/Dev/Projects/foo` vs `~/Dev/foo`), `--cwd` is ignored. The workaround is to extract the tarball, edit `meta.json`, and re-tar — or split into per-tab archives and import each with `--cwd`.
- **Session IDs are preserved.** The exported session jsonl lands at `~/.claude/projects/<slug>/<sessionId>.jsonl` on the destination. Pass `--force` to overwrite a colliding session id (e.g. when re-importing an updated export).
- **Always preview multi-tab imports with `--dry-run` first.** It reports which entries would import, which would be skipped (missing cwd), and where each session jsonl would land — useful before spawning many tabs.
