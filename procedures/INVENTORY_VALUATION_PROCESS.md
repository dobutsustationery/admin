# Inventory Valuation Production Playbook

This document describes how to reproduce the inventory valuation state that was
tested on staging after the June 18 production backup.

Source data used for this writeup:

- Production baseline: `../production-backup-jun-18/firestore-export.json`
- Staging target: `../staging-backup-jun-21-stocktake-recount/firestore-export.json`
- Comparison method: all `broadcast` documents present in staging but absent
  from the production backup by document id.

The comparison found 78 staging-only broadcast actions. Four of them have
timestamps before the production backup's maximum broadcast timestamp, but they
are still absent from production. For the purpose of reproducing staging, the
document-id diff is the authoritative list.

## Operator Goal

Bring production to the same valuation posture as staging:

1. Import the Thessaloniki Comic Con stocktake/sales event.
2. Reconstruct the one missing Order 2 receipt needed for valuation.
3. Apply the cost ledger audit decisions that were made on staging.
4. Apply the subtype cleanup decisions that affect cost attribution.
5. Apply the small catalog/listing cleanup edits that happened while staging was
   being reconciled.

System-generated Shopify catalog sync actions should not be hand-created. Run
the normal sync flow after the operator edits if production needs the catalog
snapshot refreshed.

## Production Sequence

### 1. Preflight

1. Take a fresh production backup before making any production changes.
2. Make sure production is running the rebased/merged `main` that includes the
   valuation and cost-ledger reducer fixes.
3. Open one production browser tab only while replaying or committing these
   fixes. Multiple tabs can create confusing local replay/cache behavior.
4. After the initial replay, confirm the `/unpriced`, `/inventory-value`, and
   `/cost-ledger-editor` routes load without stale local state.

### 2. Cancel staging-only orders, if they exist in production

These staging actions are not valuation fixes. They are included here only
because they are part of the staging-only action diff.

If production has these orders in the local order state, cancel them from the
order UI or equivalent order cancellation flow:

| Order | Meaning | Action |
|---|---|---|
| `shopify:17423269757277` | Shopify order `#1040`, one line: `4542804103342Dinosaur` x3 | Cancel only if it exists and should not affect inventory. |
| `shopify:17423269724509` | Shopify order `#1039`, nine line items | Cancel only if it exists and should not affect inventory. |
| `live-event:thessaloniki-comic-con:3FxZC2TXnuSvFfe11nt3` | Previous Thessaloniki live-event import | Cancel before re-importing the corrected stocktake. |

Do not manually create the two `shopify_order_reconciled` actions. If current
production Shopify polling has already imported those orders, use the normal
order state that exists in production.

### 3. Import the Thessaloniki Comic Con stocktake/sales event

Route: `/live-event-import`

What was done on staging:

1. Pasted the Thessaloniki Comic Con TSV.
2. Set the event date to `2026-05-10`.
3. Approved all parsed rows.
4. Committed the import.

Verification before committing:

| Check | Expected value |
|---|---:|
| Event name detected | `Thessaloniki Comic Con` |
| Parsed rows | 573 |
| Approved rows | 573 |
| Rows with sold quantity > 0 | 364 |
| Total sold quantity | 888 |
| Parser errors | 0 |
| Parser warnings | 0 |

The source paste can be recovered from the staging backup if needed:

```sh
node --input-type=module <<'NODE' > /tmp/thessaloniki-comic-con-stocktake.tsv
import { readFileSync } from "fs";
const backup = JSON.parse(
  readFileSync("../staging-backup-jun-21-stocktake-recount/firestore-export.json", "utf8"),
);
const action = backup.collections.broadcast.documents.find(
  (doc) => doc.id === "XOeYmHovRFqsPgnzFCtq",
);
process.stdout.write(action.data.payload.rawPaste);
NODE
```

Paste that TSV into `/live-event-import`, set the event date to `2026-05-10`,
verify the counts above, then commit.

### 4. Reconstruct the missing Order 2 receipt

Route: `/unpriced`, in the stock-order match issues remediation UI.

Create an order-date receipt for:

| Stock order | Item | Note |
|---|---|---|
| `1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD` (`Amifa #1`, Order 2) | `4542804108637Beige` | `Missing Scan` |

This is the staging action `reconstruct_stock_order_late_scan_receipt`. It
creates the missing costed receipt for the Beige subtype and is the foundation
for the later cost-ledger edits on that item.

### 5. Apply cost ledger ignore/restore decisions

Route: `/cost-ledger-editor?itemKey=...`

| Item | Ledger row to find | Final action | Note used on staging |
|---|---|---|---|
| `4542804109153Green` | `ledger:visible-qty-increase:4542804109153Green:PEo1GbAqdMnRjssHYqpc:1728457004360:12` | Restore, not ignored | `No longer needs to be ignored` |
| `4542804113396` | `ledger:visible-qty-increase:4542804113396:DTPJkusTaAZLtJYuDTdV:1746352831509:1` | Restore, not ignored | `Ignored by mistake` |
| `4542804108606Rabbit` | `ledger:qty-correction:0meLUtznxsVRVJJasoKV:ledger%3Areceipt%3AOUnpIEOQS56U8pFO6G6c%3A4542804108606Rabbit%3A%3A1699811472441:1699811472441:0.001:-3:apply-to-target` | Ignore | `Don't understand this qty correction` |
| `4542804113693` | `ledger:qty-correction:ncCWC6XRcN1DIk4R4NHQ:ledger%3Areceipt%3AFdJeGmxdOWoV2EABUxD4%3A4542804113693%3A%3A1699558448081:1699558448081:0.001:-3:apply-to-target` | Ignore | `Hack` |

For `4542804108637Beige`, staging contains exploratory ignore/restore actions
that were later undone. The final state is:

| Row | Final action |
|---|---|
| `ledger:reconstruct-stock-order-late-scan:S4eThXooGyscObNlUr8Q:1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD:4542804108637Beige:archive-sale` | Not ignored; quantity set to 4 |
| `ledger:sale:4542804108637Beige:R0vBBhUDUVtdx3k5itQJ:archive_inventory:4542804108637Beige:1746207374040:8` | Quantity set to 8 |
| `ledger:sale:4542804108637Beige:vYlgOVxW6OjORUJP5Jsy:package_item:6X347359R2707801APaolaM4:1708852342000:1` | Quantity set to 1 |

Do not repeat the intermediate "Hack to see if it fixes" or "Hacking take 2"
ignore states unless the goal is to reproduce the exact staging action log. They
were exploratory and reverted.

### 6. Apply cost ledger quantity overrides

Route: `/cost-ledger-editor?itemKey=...`

Set these ledger rows to the indicated quantities with the listed audit notes:

| Item | Ledger row | Qty | Audit note |
|---|---|---:|---|
| `4542804100945Beige` | `ledger:visible-qty-increase:4542804100945Beige:pK4iFxgH34cC4k8HxUvh:1746410683442:5` | 6 | `Adjust count to actual after Japan Festival miscount` |
| `4542804128352Pink` | `ledger:visible-qty-increase:4542804128352Pink:SgoA9NPHM7Bb7qupvthb:1746349747759:14` | 12 | `Adjust to actual count after Japan Festival` |
| `4902778133583` | `ledger:sale:4902778133583:kf3uEA8QoxeIlAZhFFnR:package_item:dimitarluckybag:1743856322000:1` | 0.2 | `To reflect piece sale not whole` |
| `4902778133583` | `ledger:sale:4902778133583:9pBySUK5l0jiZgWlBJ0k:quantify_item:dimitarluckybag:1743856322000:1` | 0.2 | `To reflect piece sale not whole` |
| `4542804108637Beige` | `ledger:reconstruct-stock-order-late-scan:S4eThXooGyscObNlUr8Q:1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD:4542804108637Beige:archive-sale` | 4 | `Unhacking` |
| `4542804108637Beige` | `ledger:sale:4542804108637Beige:R0vBBhUDUVtdx3k5itQJ:archive_inventory:4542804108637Beige:1746207374040:8` | 8 | `Returning to initial state` |
| `4542804113723Red` | `ledger:receipt:HhYGTqni0C2VWILpsV9p:4542804113723Red::1728386608404` | 3 | `Actually received 3` |
| `4542804113723Beige` | `ledger:receipt:ZjvmMWZpEOTreiDA0TSw:4542804113723Beige::1728386622648` | 8 | `Adjust count to actual` |
| `4542804113723Purple` | `ledger:receipt:Teuvy8cY0kdzbhrmLB6s:4542804113723Purple::1728386629595` | 8 | `Adjust to actual count` |
| `4542804113723Pink` | `ledger:receipt:Ur3lK2ZaaX2qPVxaUOTH:4542804113723Pink::1728386713185` | 5 | `Adjust count to actual` |
| `4542804085181Pink` | `ledger:reconstruct-stock-order-late-scan:VkpiUkM0zKUi8pPBXdhb:1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD:4542804085181Pink:receipt` | 6 | `Adjust count to actual` |
| `4542804085181Beige` | `ledger:reconstruct-stock-order-late-scan:VkpiUkM0zKUi8pPBXdhb:1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD:4542804085181Beige:receipt` | 6 | `Adjust count to actual` |
| `4542804119411Beige` | `ledger:visible-qty-increase:4542804119411Beige:V14DBhB1jn8vx8bkVXQk:1746333933007:5` | 4 | `Adjust to actual` |
| `4542804108637Beige` | `ledger:sale:4542804108637Beige:vYlgOVxW6OjORUJP5Jsy:package_item:6X347359R2707801APaolaM4:1708852342000:1` | 1 | `Return to original state` |

### 7. Apply subtype replacements

Route: `/subtype-exceptions`

| Source item | Target item | Reason |
|---|---|---|
| `4542804050851dog` | `4542804050851Dog` | `Subtype typo - missing capital.` |
| `4542804044119Multi  checks` | `4542804044119Blue` | `To correctly allocate subtypes (not 4, 2)` |
| `4542804044119Multi abstract` | `4542804044119Blue` | `To correctly allocate subtypes (not 4, 2)` |
| `4542804044119Purple` | `4542804044119Yellow` | `To correctly allocate subtypes (not 4, 2)` |
| `4542804044119Stripes` | `4542804044119Yellow` | `To correctly allocate subtypes (not 4, 2)` |

### 8. Apply listing/catalog cleanup edits

These are not core valuation fixes, but they are in the staging-only diff.

1. On item `4542804113471`, set the handle from
   `amifa-berry-cherry-wall-stickers-55-4542804113471` to
   `amifa-berry-cherry-wall-stickers-4542804113471`.
2. Set image positions for the Furukawa `49522702913xx`/`49522702914xx` group:

| Item | Final `imagePosition` |
|---|---:|
| `4952270291342` | 1 |
| `4952270291427` | 2 |
| `4952270291304` | 3 |
| `4952270291465` | 4 |

After these edits, run the normal Shopify catalog sync if the production listing
catalog needs to reflect the edits immediately. Do not hand-create
`shopifyCatalog/*` broadcast actions.

### 9. Verification

After completing the steps:

1. Replay production from broadcast or refresh cached state.
2. Open `/unpriced` and confirm the remaining cost exceptions match staging.
3. Open `/inventory-value` and confirm the order-value and cumulative inventory
   value rows match the staging-reviewed values.
4. Spot-check these items in item history and cost ledger:
   - `4542804108637Beige`
   - `4542804085181Pink`
   - `4542804085181Beige`
   - `4542804113723Red`
   - `4542804113723Beige`
   - `4542804113723Purple`
   - `4542804113723Pink`
   - `4542804108606Rabbit`
   - `4542804113693`
5. Confirm the live-event order for Thessaloniki Comic Con is present once, with
   event date `2026-05-10`.

## Appendix: Staging-Only Broadcast Action Ledger

This appendix accounts for every staging-only broadcast action found by the
backup comparison. Use the production sequence above for the recommended
operator workflow; this table is the audit trail that explains where the
workflow came from.

| # | Timestamp | Type | Action id | Operator meaning |
|---:|---|---|---|---|
| 1 | 2026-06-18T14:12:17.517Z | `shopify_order_reconciled` | `shopify_order_reconciled:17423269757277:2026-06-13T20:44:03-04:00` | Shopify order `#1040`, one line item; later canceled in staging. |
| 2 | 2026-06-18T14:12:18.116Z | `shopify_order_reconciled` | `shopify_order_reconciled:17423269724509:2026-06-13T20:44:03-04:00` | Shopify order `#1039`, nine line items; later canceled in staging. |
| 3 | 2026-06-18T14:23:05.980Z | `set_cost_ledger_entries_ignored` | `QbYozfA1pgqqpraMYTak` | Restored `4542804109153Green` visible-qty increase row; note: `No longer needs to be ignored`. |
| 4 | 2026-06-18T14:24:10.245Z | `reconstruct_stock_order_late_scan_receipt` | `S4eThXooGyscObNlUr8Q` | Created Order 2 receipt for `4542804108637Beige`; note: `Missing Scan`. |
| 5 | 2026-06-18T16:34:14.549Z | `cancel_order` | `JvpbEzs5Haaie5HwnYct` | Canceled `shopify:17423269757277`. |
| 6 | 2026-06-18T16:34:23.747Z | `cancel_order` | `neRrKhlqtFZPWX14i8rF` | Canceled `shopify:17423269724509`. |
| 7 | 2026-06-18T17:00:53.794Z | `cancel_order` | `82eEuNgX8FbA9L0ZuJDf` | Canceled prior Thessaloniki live-event order. |
| 8 | 2026-06-18T17:01:53.355Z | `liveEventImport/set_paste` | `XOeYmHovRFqsPgnzFCtq` | Pasted Thessaloniki Comic Con TSV. |
| 9 | 2026-06-18T17:02:09.419Z | `liveEventImport/set_event_date` | `tdGedD0skdwZ8VAPU6gA` | Set event date to `2026-05-10`. |
| 10 | 2026-06-18T17:02:28.794Z | `liveEventImport/commit_import` | `k0tuKcVU4JWswTFDkWSp` | Committed the approved Thessaloniki sales. |
| 11 | 2026-06-18T17:12:06.817Z | `set_cost_ledger_entries_ignored` | `Y6Ae5aX1JXhY7Ur6gdQC` | Restored `4542804113396` visible-qty increase row; note: `Ignored by mistake`. |
| 12-16 | 2026-06-18T17:17:00Z | `shopifyCatalog/*` | `NXtDx...` to `9j70...` | Incremental Shopify catalog sync, 423 listings total across three chunks. |
| 17 | 2026-06-18T17:18:37.344Z | `update_field` | `jEBsuJVtkazrn6khjaXM` | Changed `4542804113471` handle to remove `-55-`. |
| 18-23 | 2026-06-18T17:18:40Z to 17:32:27Z | `shopifyCatalog/*` | multiple | Two incremental Shopify catalog syncs after the handle edit. |
| 24-27 | 2026-06-19T11:24:33Z | `shopifyCatalog/*` | multiple | Incremental Shopify catalog sync, 301 listings total across two chunks. |
| 28 | 2026-06-19T13:03:38.063Z | `set_cost_ledger_entry_qty` | `0QelTmEqsIHt6zx8fhih` | Set `4542804100945Beige` visible-qty increase row to 6. |
| 29 | 2026-06-19T13:08:45.432Z | `set_cost_ledger_entry_qty` | `rD7sWSIiWtGA77U84aF6` | Set `4542804128352Pink` visible-qty increase row to 12. |
| 30-38 | 2026-06-19T13:18:23Z to 2026-06-20T04:13:19Z | `shopifyCatalog/*` | multiple | Three incremental Shopify catalog syncs for four changed listings each. |
| 39 | 2026-06-20T04:31:02.260Z | `replace_subtype` | `lApCEpOeprUULqXThznf` | Replaced `4542804050851dog` with `4542804050851Dog`. |
| 40 | 2026-06-21T13:40:24.853Z | `replace_subtype` | `6cmweRvcdVY5rIToX4Eu` | Replaced `4542804044119Multi  checks` with `4542804044119Blue`. |
| 41 | 2026-06-21T13:40:41.409Z | `replace_subtype` | `N5IZG35Y9VmKo1pLnNfZ` | Replaced `4542804044119Multi abstract` with `4542804044119Blue`. |
| 42 | 2026-06-21T13:40:51.393Z | `replace_subtype` | `9d7fe0LLm3cRQtwZOw0P` | Replaced `4542804044119Purple` with `4542804044119Yellow`. |
| 43 | 2026-06-21T13:40:56.751Z | `replace_subtype` | `ksiCHqerbRYVy31m5irI` | Replaced `4542804044119Stripes` with `4542804044119Yellow`. |
| 44 | 2026-06-21T13:54:44.839Z | `set_cost_ledger_entry_qty` | `FjoZLmOZukK4xliGHa8Z` | Set one `4902778133583` Dimitarluckybag sale row to 0.2. |
| 45 | 2026-06-21T13:54:54.013Z | `set_cost_ledger_entry_qty` | `1hskRoP9HTrFiovq8bOA` | Set second `4902778133583` Dimitarluckybag sale row to 0.2. |
| 46 | 2026-06-21T14:07:11.852Z | `set_cost_ledger_entries_ignored` | `VvvL36YR7VAjmkzGRNrj` | Temporarily ignored the `4542804108637Beige` reconstructed archive-sale row. Superseded. |
| 47 | 2026-06-21T14:08:09.225Z | `set_cost_ledger_entries_ignored` | `ybZppZRpi7ZwJS1AaYjS` | Restored the same `4542804108637Beige` row. |
| 48 | 2026-06-21T14:08:27.102Z | `set_cost_ledger_entry_qty` | `ADy5nRfrHCjyryaobzWZ` | Temporarily set the same `4542804108637Beige` row to 8. Superseded. |
| 49 | 2026-06-21T14:10:24.666Z | `set_cost_ledger_entry_qty` | `Daa1pth7TeSKfeMb69EO` | Final value for the reconstructed archive-sale row: qty 4. |
| 50 | 2026-06-21T14:25:03.738Z | `set_cost_ledger_entry_qty` | `VhhfIY5L6nVwMK70cRST` | Temporarily set `4542804108637Beige` archive sale to 10. Superseded. |
| 51 | 2026-06-21T14:26:03.562Z | `set_cost_ledger_entries_ignored` | `m6UmCQiB7IYsZcQ5MBMi` | Temporarily ignored the reconstructed archive-sale row again. Superseded. |
| 52 | 2026-06-21T14:26:54.441Z | `set_cost_ledger_entries_ignored` | `TIG0GajVhu9X0aKpWTva` | Restored the reconstructed archive-sale row again. |
| 53 | 2026-06-21T14:27:08.683Z | `set_cost_ledger_entry_qty` | `EPbBVDanboOoMhLFoyNP` | Final value for `4542804108637Beige` archive sale: qty 8. |
| 54 | 2026-06-21T14:41:04.018Z | `set_cost_ledger_entry_qty` | `iNHpf8zsKPRhSPHbd4Nz` | Set `4542804113723Red` receipt qty to 3. |
| 55 | 2026-06-21T14:41:44.023Z | `set_cost_ledger_entry_qty` | `zrD7vLuDvkiwdRSwmVcD` | Set `4542804113723Beige` receipt qty to 8. |
| 56 | 2026-06-21T14:41:51.098Z | `set_cost_ledger_entries_ignored` | `DQXijCBBl22CgYD4veq4` | Temporarily ignored `4542804113723Purple` receipt. Superseded. |
| 57 | 2026-06-21T14:41:53.011Z | `set_cost_ledger_entries_ignored` | `h6sZsulqCg2fIUl2wmXY` | Restored `4542804113723Purple` receipt. |
| 58 | 2026-06-21T14:42:04.461Z | `set_cost_ledger_entry_qty` | `GjA4dr6q6EVR3jmcis4c` | Set `4542804113723Purple` receipt qty to 8. |
| 59 | 2026-06-21T14:42:23.292Z | `set_cost_ledger_entry_qty` | `HnXqLOAmlLQUL1KhduG2` | Set `4542804113723Pink` receipt qty to 5. |
| 60 | 2026-06-21T14:47:48.217Z | `set_cost_ledger_entry_qty` | `KRtvZggvQ4dpRl5PTwzK` | Set reconstructed Order 2 receipt for `4542804085181Pink` to 6. |
| 61 | 2026-06-21T14:48:07.656Z | `set_cost_ledger_entry_qty` | `CjA7mlzMVDhNUEXBUyoz` | Set reconstructed Order 2 receipt for `4542804085181Beige` to 6. |
| 62 | 2026-06-21T14:52:51.063Z | `set_cost_ledger_entries_ignored` | `4UOBuPKMJN6Tiat04fc5` | Ignored questionable `4542804108606Rabbit` qty correction. |
| 63 | 2026-06-21T15:01:10.477Z | `set_cost_ledger_entry_qty` | `xSNrkaYT3K4ya03AmLNN` | Set `4542804119411Beige` visible-qty increase row to 4. |
| 64 | 2026-06-21T15:04:38.307Z | `set_cost_ledger_entries_ignored` | `mt03um90uzkBdaI23kf6` | Ignored questionable `4542804113693` qty correction. |
| 65 | 2026-06-21T15:13:49.580Z | `set_cost_ledger_entry_qty` | `H9eCHMxRaQlgKtKavNG0` | Temporarily set a `4542804108637Beige` Paola sale row to 5. Superseded. |
| 66 | 2026-06-21T15:14:42.301Z | `set_cost_ledger_entry_qty` | `ZWhdb7xZ6BVu5mSaFRT7` | Final value for that `4542804108637Beige` Paola sale row: qty 1. |
| 67 | 2026-06-21T15:26:01.448Z | `update_field` | `5VS1oiIX2v5XOvbyhsIz` | Set `4952270291342` image position to 1. |
| 68 | 2026-06-21T15:26:01.520Z | `update_field` | `dSJp0WU0N7Y07ZpQf9F0` | Temporarily set `4952270291465` image position to 2. Superseded. |
| 69 | 2026-06-21T15:26:01.569Z | `update_field` | `EIf31gzZjnv6WvMj2ovk` | Temporarily set `4952270291304` image position to 3. |
| 70 | 2026-06-21T15:26:01.614Z | `update_field` | `iHiElitDTWJABtFzS43b` | Temporarily set `4952270291427` image position to 4. Superseded. |
| 71 | 2026-06-21T15:26:12.205Z | `update_field` | `Lw1OQniew88wZ0BPskP1` | Temporarily set `4952270291304` image position to 2. Superseded. |
| 72 | 2026-06-21T15:26:12.260Z | `update_field` | `TrjlziPJ9SSrUuN3wGDU` | Temporarily set `4952270291427` image position to 3. Superseded. |
| 73 | 2026-06-21T15:26:12.324Z | `update_field` | `xTwCBZ08IHZhAuelZUi2` | Final value for `4952270291465`: image position 4. |
| 74 | 2026-06-21T15:26:13.826Z | `update_field` | `Of8Wt1WvDXkKWu2yZUAp` | Final value for `4952270291427`: image position 2. |
| 75 | 2026-06-21T15:26:13.878Z | `update_field` | `aH401mzTBIoBdeweGc5e` | Final value for `4952270291304`: image position 3. |
| 76 | 2026-06-21T15:53:24.165Z | `shopifyCatalog/begin_sync` | `kK49ssGdSyAFWOD5TgyL` | Started final observed Shopify catalog incremental sync. |
| 77 | 2026-06-21T15:53:24.166Z | `shopifyCatalog/apply_sync_chunk` | `QEbY8p1jd5ARsJJG7L9X` | Applied final observed Shopify catalog sync chunk, four listings. |
| 78 | 2026-06-21T15:53:24.167Z | `shopifyCatalog/complete_sync` | `Eb5oTKuevy3GWT9mhU2u` | Completed final observed Shopify catalog incremental sync. |
