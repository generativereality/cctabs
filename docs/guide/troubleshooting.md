---
title: Troubleshooting — cctabs
description: Diagnosing common cctabs and Wave Terminal failure modes — including the orphan-tabid bug that empties `wsh blocks list`.
---

# Troubleshooting

## `cctabs sessions` shows nothing / "no tabs found" after a Wave restart

Symptoms:

- `cctabs sessions` (or `list`, `restore`, `close`, …) prints an empty list,
  or fails with a vague "no blocks" warning.
- Running `wsh blocks list --json --workspace <your-workspace-id>` by hand
  fails with:

  ```
  couldn't list blocks for workspace 6f57…: not found
  ```

- Wave Terminal itself still works — your tabs are visible, blocks render,
  things look normal in the UI.

### Why this happens

Wave stores each workspace's tab list as a JSON array in
`db_workspace.data.tabids`, and the actual tab rows in `db_tab`. After certain
crash / restart sequences, a `tabids` entry can be left pointing at a tab row
that has already been deleted from `db_tab` — an orphan tabid.

Wave's `BlocksList` RPC iterates the workspace's tabids and calls
`wstore.DBMustGet[*Tab]` on each one. The first orphan returns `not found`,
which the RPC propagates up — aborting the whole listing instead of skipping
the bad row. wsh surfaces this as the error above; cctabs sees an empty block
list and produces a confusing message.

(Source: `pkg/wshrpc/wshserver/wshserver.go`, `BlocksListCommand` —
the inner `for _, tabID := range wsData.TabIds` loop returns on error.)

### Fix it with `cctabs doctor`

`cctabs doctor` reads `~/Library/Application Support/waveterm/db/waveterm.db`
directly via `sqlite3`, compares each workspace's `tabids` against the rows
present in `db_tab`, and reports the orphans.

Diagnose only:

```bash
cctabs doctor
```

Apply the fix interactively (recommended):

```bash
cctabs doctor --fix
```

Or skip the confirmation prompt:

```bash
cctabs doctor --fix --yes
```

What `--fix` does:

1. Copies the Wave DB to a timestamped backup next to it
   (`waveterm.db.cctabs-backup-YYYY-MM-DD…`).
2. For each affected workspace, rewrites `data.tabids` to drop just the
   orphan IDs. The remaining tabs and `db_tab` itself are untouched.

::: warning Quit Wave Terminal first
Quit Wave (`Cmd+Q`) before running `cctabs doctor --fix`. Wave caches the
workspace in memory and will overwrite the cleaned `tabids` array on its next
save — undoing the fix.
:::

### Manual repair, if you'd rather not run `--fix`

```sql
-- Inspect a workspace's tabids:
SELECT json_extract(data, '$.tabids') FROM db_workspace WHERE oid = '<workspace-oid>';

-- Find which of those IDs are orphans:
WITH t(id) AS (SELECT value FROM db_workspace, json_each(data, '$.tabids') WHERE oid = '<workspace-oid>')
SELECT id FROM t WHERE id NOT IN (SELECT oid FROM db_tab);

-- Replace the array with just the live ones:
UPDATE db_workspace
SET data = json_set(data, '$.tabids',
  (SELECT json_group_array(id) FROM (
    SELECT value AS id FROM json_each(json_extract(data, '$.tabids'))
    WHERE value IN (SELECT oid FROM db_tab)
  ))
)
WHERE oid = '<workspace-oid>';
```

### Upstream

The underlying RPC behaviour is a Wave Terminal issue — `BlocksList` should
log and skip a missing tab rather than abort the whole listing. cctabs ships a
draft of that issue in `notes/waveterm-blockslist-orphan-tabid.md`.

## Other issues

If `cctabs sessions` returns confusing data after a restart but `cctabs doctor`
reports a clean DB, see [Session Workflows → Restoring after a
restart](./workflows.md) — the ephemeral-workspace handling lives in
`src/core/wave.ts` (`getAllData`).
