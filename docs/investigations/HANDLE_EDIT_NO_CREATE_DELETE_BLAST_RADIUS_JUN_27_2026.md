# Inventory Updates Must Not Create Listings -- Jun 27 2026

## Summary

This report covers the working-tree change that enforces a stricter listing
creation rule:

> Inventory updates and handle edits must not create or delete listing rows.

Expected listing creation paths are:

- Shopify import / Shopify listing import.
- Listing draft approval.
- Explicit listing actions.

The concrete problem example was
`bag-ziplock-masterpiece-square-4542804119091`: this was not created by a
Shopify import or a listing draft approval. It was synthesized by the old
`update_item` replay path from the scanned inventory description
`Bag Ziplock Masterpiece Square`.

The attempted fix is now clean for accounting and inventory. It removes
scan-synthesized local listing rows and preserves the real Shopify/imported
listing rows. There are still listing-state diffs to review, especially one
Love & Fur handle inconsistency that the old reducer was hiding.

## Code Change

The attempt changes the listing reducer and Shopify import orchestration:

- `update_item` no longer creates `handleToListing` rows.
- Generic `bulk_import_items` no longer creates `handleToListing` rows.
- Those inventory actions may link an item only when the target listing row
  already exists.
- `update_field(handle)` no longer creates, moves, or deletes listing rows.
- `update_field(handle)` preserves dormant option labels on the previous
  listing so relinking does not degrade explicit option labels to `Default`.
- Shopify import now emits explicit `create_listing` updates so Shopify import
  remains a valid creation path without relying on inventory side effects.
- Listing draft approval still creates/updates the approved listing, but no
  longer deletes prior listing rows as incidental cleanup.

## Blast Radius Command

```bash
npm run blast-radius -- compare \
  --base HEAD \
  --head working-tree \
  --backup ../production-backup-jun-26-trace-4542804151626 \
  --name no-inventory-listing-creation-jun27-v3
```

Artifacts:

- Generated report: `.blastradius/runs/no-inventory-listing-creation-jun27-v3/report.md`
- Exhaustive leaf diff: `.blastradius/runs/no-inventory-listing-creation-jun27-v3/report.full-state-diff.json`
- Base replay: `.blastradius/runs/no-inventory-listing-creation-jun27-v3/bccaedd2fbf5.json`
- Working-tree replay: `.blastradius/runs/no-inventory-listing-creation-jun27-v3/working-tree.json`

For full Markdown detail:

```bash
bun scripts/inventory-replay-dump.ts diff \
  .blastradius/runs/no-inventory-listing-creation-jun27-v3/bccaedd2fbf5.json \
  .blastradius/runs/no-inventory-listing-creation-jun27-v3/working-tree.json \
  --out .blastradius/runs/no-inventory-listing-creation-jun27-v3/report.full.md \
  --detail-limit 0
```

## Validation

Focused unit tests passed:

```bash
npm run test:unit -- \
  tests/unit/listing-handle-update.test.ts \
  tests/unit/listing-handle-sync.test.ts \
  tests/unit/shopify-import-listing-images.test.ts
```

## Accounting And Inventory Impact

No accounting, inventory, order, or valuation state changed.

| Surface | Result |
|---|---|
| Actions replayed | `42,863 -> 42,863` |
| `inventory.idToItem` | No changed keys; no added or removed items. |
| `inventory.costLedger` | No changed keys; no added or removed entries. |
| Order value summary | Rows changed: 0. Mismatch vector stayed `0, 9100, 0, 0, 0, 0`. |
| Inventory value report | Rows changed: 0. Current residual JPY stayed `0`. |
| Recount found stock | Rows changed: 0. Count stayed `0`. |
| Average costs | 0 changes. |
| Received cost basis | 0 changes. |
| On-hand inventory value | JPY stayed `809,987.42`; EUR stayed `4,725.2897`. |

This is the important positive result: the blast radius is confined to listing
and photo state.

## Full Redux Diff Coverage

| Slice | Added leaves | Removed leaves | Changed leaves | Total | Judgment |
|---|---:|---:|---:|---:|---|
| `listings` | 41 | 6,142 | 34 | 6,217 | Expected area of impact. Requires product review. |
| `photos` | 0 | 0 | 26 | 26 | Synthetic replay metadata churn already seen in prior reports. |
| Other slices | 0 | 0 | 0 | 0 | Expected and good. |

The 26 `photos` diffs are generated metadata differences. No listing image URL,
inventory item, cost, order, or valuation result moved because of them.

## Concrete Example Result

### `bag-ziplock-masterpiece-square-4542804119091`

This scan-generated local listing is gone after the fix.

| State | Result |
|---|---|
| Before | No row in the current branch base replay. |
| After | No row. |
| Judgment | Good. The old scan-synthesized row is not recreated. |

The active Shopify/imported listing remains intact:

| Handle | Result |
|---|---|
| `amifa-masterpiece-collection-zipper-bag-4542804119091` | Exists before and after. |
| Variants | `4542804119091Strawberry`, `4542804119091Roses` remain linked. |
| Option labels | `Strawberry`, `Roses` remain present. |

### `amifa-berry-cherry-wall-stickers-4542804113471`

This was the prior handle-edit example. It stays correct.

| Field | Before | After |
|---|---|---|
| Listing exists | yes | yes |
| Linked item | `4542804113471` | `4542804113471` |
| Option label | `red` | `red` |
| Item handle | `amifa-berry-cherry-wall-stickers-4542804113471` | same |
| Qty / shipped | `39 / 2` | same |
| Cost / price | `35 JPY / EUR 4` | same |

This confirms that preserving dormant option labels fixed the earlier
`Default` regression.

## Listing Row Impact

| Metric | Before | After | Delta | Judgment |
|---|---:|---:|---:|---|
| Local `handleToListing` rows | 788 | 427 | -361 | Large but expected direction: scan-synthesized listings are no longer created. |
| Removed local listing rows | 362 | - | - | Mostly generated inventory-scan listings. |
| Added local listing rows | - | 1 | +1 | A listing draft approval row that no longer gets moved/deleted by later handle behavior. |
| Changed local listing rows | 167 | - | - | Mostly option/index details on surviving real listings. |
| Removed rows also present in Shopify catalog mirror | 1 | - | - | Needs review; see Love & Fur below. |

The old local listing set had many rows that could only exist because
`update_item` synthesized listings from inventory data. Examples of removed
generated rows include:

| Removed handle | Interpretation |
|---|---|
| `masking-label-stickers-48ct-4980299065828` | Generated inventory description handle. |
| `fabric-stickers-11ct-4980299030451` | Generated inventory description handle. |
| `b5-kraft-envelopes-10ct-4968583218556` | Generated inventory description handle. |
| `bag-drawstring-nylon-4542804103892` | Generated inventory description handle. |
| `bag-nylon-tulle-4542804115604` | Generated inventory description handle. |
| `stickers-cats-striped-4580424666014` | Generated inventory description handle. |

The full list is in the full diff artifact.

## Listing Index Impact

| Metric | Before | After | Delta | Judgment |
|---|---:|---:|---:|---|
| `idToHandle` entries | 1,254 | 837 | -417 | Expected direction: links to scan-synthesized local listing rows disappear. |
| Added `idToHandle` entries | 0 | 0 | 0 | Expected. |
| Changed `idToHandle` entries | 0 | 0 | 0 | Expected. |

Unlike the earlier failed attempt, this run does not show broad active-listing
link loss from Shopify import. The Shopify import order was corrected so
explicit Shopify-created listings exist before inventory rows are re-linked.

## Listing Detail / Variant Label Impact

The blast-radius report derives listing-detail labels from the same state the
UI uses.

| Metric | Count | Judgment |
|---|---:|---|
| Listing-detail pages with variant label changes | 341 | Mostly removed generated local listing pages. |
| New `Default` label regressions | 0 | Good. |
| Listing variant/option leaf diffs | 494 | Expected surface to review. |

Many changed rows have an empty “after” because the old page was a generated
local listing that no longer exists. This is the desired class of cleanup, but
the volume is large enough that product review is warranted before landing.

## Open Concern: Love & Fur

One removed local row also exists in the Shopify catalog mirror:

`kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`

Before the fix, local listing state had:

- handle `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`
- title `Kyowa Love & Fur Dog Mini Sticky Notes (75)`
- linked variants:
  - `4969757171813Pomeranian`
  - `4969757171813Poodle`
  - `4969757171813Schnauzer`
  - `4969757171813Shiba`

After the fix:

- the item records still have `item.handle =
  kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`
- the Shopify catalog mirror still has that handle
- `listings.idToHandle` no longer links those items
- the local listing row instead exists under
  `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-4969757171813`

This relates to the earlier handle slug investigation documented in
`docs/investigations/PROPOSAL_HANDLE_NOT_SLUGIFIED.md`.

Interpretation: the old reducer hid this inconsistency by allowing inventory
updates to synthesize or relink listing rows. The stricter rule exposes that
the local listing approval/import history and the final Shopify/catalog handle
do not agree.

This should not be fixed by allowing `update_item` to create listings again.
It needs an explicit policy:

- either a Shopify catalog/import reconciliation should create/link the local
  listing for `...-77`, or
- the local listing approval path should be corrected to the canonical Shopify
  handle, or
- the item handles should be changed through an explicit operator action.

## Landing Judgment

| Area | Status | Reason |
|---|---|---|
| Inventory updates do not create listings | Good | `update_item`/generic `bulk_import_items` now only link to existing rows. |
| Handle edits do not create/delete listing rows | Good | `applyHandleUpdate` no longer creates, moves, or deletes rows. |
| Shopify import creates listings explicitly | Good | Import emits `create_listing` updates instead of relying on inventory side effects. |
| Listing approval creation | Good | Approval still materializes the approved listing. |
| Inventory/cost/order/accounting | Good | No movement. |
| `Default` regressions | Good | Count is 0. |
| Generated local listing cleanup | Needs review | 362 local listing rows are removed. This is expected directionally but broad. |
| Love & Fur handle inconsistency | Needs decision | The stricter model exposes a real mismatch between item handles, local listing approval state, and Shopify catalog state. |

## Proposed Next Step

Review the removed generated listing set and decide whether the broad cleanup
is acceptable. If it is, handle the Love & Fur case as an explicit
reconciliation problem rather than restoring inventory-driven listing creation.
