# Wave Terminal upstream issue (draft)

**Title:** `BlocksList` aborts the entire workspace listing on the first
orphan tabid; should log+continue

**Repo:** https://github.com/wavetermdev/waveterm

## Summary

`WshServer.BlocksListCommand` (in
`pkg/wshrpc/wshserver/wshserver.go`, around L913–L944 on `main` as of writing)
iterates each tab id from `wsData.TabIds` and calls
`wstore.DBMustGet[*waveobj.Tab]` on it. If any of those tab ids no longer
exists in `db_tab` (an "orphan tabid" — see "Reproducing" below for how this
state arises), the helper returns `not found` and the RPC returns immediately.

```go
for _, tabID := range wsData.TabIds {
    tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
    if err != nil {
        return nil, err            // <-- aborts the whole listing
    }
    for _, blkID := range tab.BlockIds {
        ...
    }
}
```

The result is that one stale id in a single workspace's `tabids` array
silently disables `wsh blocks list` for that workspace entirely — with no
hint that the rest of the workspace is fine. Tools that depend on
`BlocksList` (such as `cctabs`) see an empty result with a generic
`couldn't list blocks for workspace <oid>: not found` on stderr, which is
hard to attribute back to "one tab id is bad."

## Impact

- Any external tool using `wshrpc`'s `BlocksList` (or `wsh blocks list`) is
  effectively broken for the affected workspace until the DB is hand-fixed.
- The Wave UI itself is unaffected — it appears to render tabs / blocks via a
  different code path that tolerates the missing row — so users have no
  in-app signal that anything is wrong.
- The error surface (`not found`) does not include the offending tab id,
  making manual diagnosis tedious.

## Reproducing

We've been able to land in this state organically after a Wave restart, but a
deterministic repro is:

1. Open Wave; note your current workspace's oid (`$WAVETERM_WORKSPACEID`).
2. With Wave quit, in `db/waveterm.db`:

   ```sql
   -- pick any uuid that does not exist in db_tab
   UPDATE db_workspace
   SET data = json_insert(data, '$.tabids[#]', '00000000-0000-0000-0000-000000000000')
   WHERE oid = '<your-workspace-oid>';
   ```

3. Start Wave. Run `wsh blocks list --json --workspace <your-workspace-oid>`
   → fails with `couldn't list blocks for workspace …: not found`.

(In real-world cases we've seen the orphan id correspond to a tab that was
deleted from `db_tab` while its id remained in some workspace's `tabids`.
Whatever the upstream cause of the inconsistency, the RPC's behaviour on
encountering it is the focus of this issue.)

## Suggested fix

Treat a missing tab as "skip with a log line" rather than a fatal RPC error.
Concretely, in `BlocksListCommand`:

```go
for _, tabID := range wsData.TabIds {
    tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
    if err != nil {
        // orphan tabid — log and continue so a single stale entry doesn't
        // disable the whole listing
        log.Printf("BlocksList: skipping missing tab %s in workspace %s: %v", tabID, wsID, err)
        continue
    }
    for _, blkID := range tab.BlockIds {
        blk, err := wstore.DBMustGet[*waveobj.Block](ctx, blkID)
        if err != nil {
            log.Printf("BlocksList: skipping missing block %s in tab %s: %v", blkID, tabID, err)
            continue
        }
        results = append(results, wshrpc.BlocksListEntry{ ... })
    }
}
```

Optional but valuable companion changes:

1. **Self-healing hook.** When `BlocksList` (or another read path) detects an
   orphan tabid, queue a background cleanup that rewrites the workspace's
   `tabids` to drop ids absent from `db_tab`. This would also fix the
   underlying inconsistency without requiring users to run external tools.
2. **Schema-level prevention.** Investigate the deletion path for `db_tab`
   rows to see whether tab deletion can leave the workspace's `tabids`
   unupdated; a single transaction that deletes the row *and* removes the id
   from every referencing `db_workspace.data.tabids` would prevent the
   inconsistency from arising in the first place.

## Workaround for affected users today

We've shipped `cctabs doctor` (in [cctabs](https://github.com/generativereality/cctabs))
which reads `db_workspace` + `db_tab` directly via `sqlite3`, finds orphan
tabids, backs up the DB, and rewrites `data.tabids` to drop them. Happy to
contribute the relevant SQL upstream if a self-healing hook is in scope.

## Environment

- Wave version: <fill in> (commit referenced: `pkg/wshrpc/wshserver/wshserver.go` ~ L913–L944)
- macOS 15 / Darwin 25.x
- Reproduced via direct `wsh blocks list` invocation as well as cctabs.
