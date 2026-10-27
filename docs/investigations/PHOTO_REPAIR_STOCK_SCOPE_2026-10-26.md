# Stocked photo queue correction

The earlier discovery run created 589 image-version entries from 584 source photos, including unused and zero-stock references. Those records remain intact. The main queue now starts from positive stock and current assigned/gallery images, across all brands; import history only helps locate an original.

On the captured production state, 192 old discovery entries have no current stocked use. There are eight stocked items with no assigned image or saved gallery fallback. Current dimension checks and explicit visual decisions determine which other files need attention. Files at least 1024 pixels on the longest side are excluded by default; the user can still flag a poor large photo or dismiss a suitable small one. Decisions do not carry over to a different file or Shopify master version.

Missing-photo approval fills the inventory image and appends a gallery slot when a saved listing exists. Inventory-only items remain local. Shared uses are grouped, existing work is preferred, and matching duplicate group occurrences are all updated while other edits remain unchanged. An existing suitable photo can be used without downloading or processing it again, followed by the usual individual approval.

## Validation

- Full unit suite: 711 passed, one skipped. Subsequent focused changes pass 25 tests covering stock scope, quality decisions, current versions, missing photos, duplicate references, preserving different edits and keeping inventory-only approvals local.
- Chromium emulator tests pass for upload/process/redo/reload/approval and the corrected stock/current-photo selection, skipping a fixed image despite historical bad import, persistent good decisions, subjective flagging of large images, and missing-photo completion. External image/Drive responses are mocked.
- Svelte check reports zero errors and warnings; formatting and production-build checks pass.

## Production replay

- Backup: `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2/data-export/photo-repair-stock-before/firestore-export.json` (53,797 original broadcasts plus 1,173 newly captured discovery events).
- Baseline: `bf293af57cf7`.
- Head: `working-tree`, exploratory implementation capture before the correction commit.
- Run directory: `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2/.blastradius/runs/photo-repair-stock-scope/`.
- Reviewed artifacts: `metadata.json`, `bf293af57cf7.json`, `working-tree.json`, `report.md` and `report.full-state-diff.json`.

Both replays process 54,970 events with zero errors. All 589 discovery entries are retained. The only state differences are empty current-photo measurement/review maps and schema version 29 to 30. Inventory remains 1,415 items; no item, cost ledger, order, history, existing photo or listing data changes through replay. Later refinements apply only to new checks and approvals and are covered by the focused tests.

## Release

This correction requires Hosting only. It uses existing authenticated broadcast permissions and unchanged import, processing and Shopify workers. Reloading rebuilds the browser cache for schema 30. The user then chooses **Check stocked item photos**; no photo replacement is approved by deployment.
