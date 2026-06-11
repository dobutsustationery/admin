# Shopify Order Reconciled Duplicate Cleanup

Date: 2026-06-04

## Scope

This plan only covers duplicate `shopify_order_reconciled` rows in the
`broadcast` collection. It does not cover `shopify_api_log`, Etsy reconcile
rows, or sync lifecycle rows.

Source dataset:

```text
../production-backup-jun-04/firestore-export.json
```

## Rule

Group `shopify_order_reconciled` broadcast rows by:

- Shopify order id (`raw.id` or `raw.admin_graphql_api_id`)
- external version timestamp (`raw.updated_at || raw.created_at`)
- stable hash of the full raw Shopify order payload

For each group:

1. Keep the earliest broadcast row. This preserves the replayable raw external
   fact at the point it first entered the log.
2. Keep the latest duplicate row. Current reducer behavior clears
   `shopifyExceptions[orderID]` before checking whether a reconcile fact is
   stale, so the latest duplicate can be preserving the current exception state.
3. Move all middle duplicate rows out of `broadcast` into a jail/archive
   collection.

The cleanup should move rows, not hard-delete them. The archived row should
retain the original data and add cleanup metadata pointing to the kept rows.

## Jun 04 Counts

Dry run:

```sh
node scripts/cleanup-shopify-order-reconciled-duplicates.mjs \
  --backup ../production-backup-jun-04 \
  --write-manifest /tmp/shopify-order-reconciled-safe-duplicates-jun-04.json
```

Results:

```text
broadcastDocs: 41703
shopifyOrderReconciledDocs: 3683
uniqueRawOrderVersions: 44
keptDocs: 44
exactDuplicateDocs: 3639
keptLatestDuplicateDocs: 16
removableDuplicateDocs: 3623
duplicateGroups: 16
```

Largest removable groups:

```text
1241  order=13291677483390 version=2026-05-14T22:23:53+03:00
 649  order=13245121266046 version=2026-05-04T21:44:46+03:00
 521  order=13191023821182 version=2026-04-21T19:43:12+03:00
 388  order=13348110696830 version=2026-05-29T13:08:48+03:00
 331  order=13245121266046 version=2026-05-01T10:32:44+03:00
```

## Verification

The naive plan to remove every exact duplicate beyond the first copy removed
`3,639` rows, but replay changed `inventory.shopifyExceptions`. Items, item
history, orders, and cost ledger were identical, but exception state differed.

The safer plan above removes only middle duplicates (`3,623` rows), keeping the
latest duplicate in each duplicated group. Verification command:

```sh
bun scripts/verify-shopify-reconcile-duplicate-prune.ts \
  ../production-backup-jun-04 \
  /tmp/shopify-order-reconciled-safe-duplicates-jun-04.json
```

Result:

```text
Original actions: 41703
Filtered actions: 38080
Removed actions: 3623
Original inventory/order projection hash: a00368f3ccfc186d699a0461f91b87bee6414e64bb0c4121c95d4f83c9da102e
Filtered inventory/order projection hash: a00368f3ccfc186d699a0461f91b87bee6414e64bb0c4121c95d4f83c9da102e
Inventory/order projection is identical after filtering duplicate reconcile rows.
```

## Execution Plan

1. Take a fresh backup immediately before cleanup.
2. Generate a fresh manifest from that backup.
3. Run the replay verifier against the fresh backup and manifest.
4. Execute the manifest against production with:

```sh
node scripts/cleanup-shopify-order-reconciled-duplicates.mjs \
  --execute \
  --force \
  --firestore-env production \
  --manifest /tmp/shopify-order-reconciled-safe-duplicates-jun-04.json \
  --jail-collection broadcast_jail_shopify_order_reconciled_duplicates
```

5. Take another production backup.
6. Verify `broadcast` count decreased by the manifest row count and the jail
   collection contains exactly those moved rows.
7. Replay the post-cleanup backup and compare inventory/order projection against
   the pre-cleanup projection.

## Follow-Up

The reducer side effect is surprising: stale `shopify_order_reconciled` actions
clear `shopifyExceptions` before returning. That should be reviewed separately.
Once corrected, future cleanup may be able to remove all exact duplicate copies
beyond the earliest raw fact instead of keeping the latest duplicate.
