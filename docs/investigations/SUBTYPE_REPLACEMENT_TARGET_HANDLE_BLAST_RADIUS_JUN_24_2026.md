# Subtype Replacement Target Handle Blast Radius — Jun 24 2026

## Summary

`replace_subtype` previously migrated the retired source item's listing handle onto
the target item unconditionally. That is correct when the target item has no
listing relationship yet, but wrong when the target subtype already exists and
already has a canonical listing handle.

This produced stale listing ownership for recent zipper pouch subtype
replacements: the target `Green` variants were moved from canonical `amifa-*`
listing handles back to older `amifaspecial-*` handles.

The reducer fix preserves the target item's existing listing handle during
`replace_subtype` when it differs from the source handle. It still removes the
source item from the retired source listing. Other rename/subtype-update paths
keep the prior migration behavior.

## Blast Radius Command

Formal blast-radius run:

```bash
npm run blast-radius -- compare \
  --base HEAD \
  --head working-tree \
  --backup /tmp/production-backup-jun-23-plus-delta.json \
  --name subtype-replacement-target-handle-fix-jun24
```

Artifacts:

- Report: `.blastradius/runs/subtype-replacement-target-handle-fix-jun24/report.md`
- Full state diff: `.blastradius/runs/subtype-replacement-target-handle-fix-jun24/report.full-state-diff.json`
- Base replay: `.blastradius/runs/subtype-replacement-target-handle-fix-jun24/9bbe4383423e.json`
- Fixed replay: `.blastradius/runs/subtype-replacement-target-handle-fix-jun24/working-tree.json`

## Accounting Impact

No accounting or inventory state changes were found.

| Metric | Before | After |
|---|---:|---:|
| Actions | 41,975 | 41,975 |
| Replay errors | 0 | 0 |
| Inventory items | 1,297 | 1,297 |
| Cost ledger keys | 1,297 | 1,297 |
| Orders | 104 | 104 |
| Order lines | 2,084 | 2,084 |
| Missing COO | 398 | 398 |
| Missing weight | 398 | 398 |

The script also reported:

- `inventory.idToItem`: unchanged
- `inventory.costLedger`: unchanged
- `inventory.stockOrderRegistry`: unchanged
- `inventory.orderIdToOrder`: unchanged
- Order value summary mismatch vector: `0, 9100, 0, 0, 0, 0` before and after
- Inventory value: `¥815,927.65` before and after
- Average cost changes: 0
- Received cost-basis changes: 0

## Listing Impact

The semantic impact is limited to listing handle ownership and listing-detail
variant labels for existing `replace_subtype` actions.

| Item | Before `idToHandle` | After `idToHandle` | Assessment |
|---|---|---|---|
| `4542804155174Green` | `amifaspecial-a4-two-zipper-net-stationery-case-4542804155174` | `amifaspecial-a4-two-zipper-net-stationery-case-4542804155174` | Unchanged; source and target relationship was already correct. |
| `4542804155181Green` | `amifaspecial-a5-two-zipper-net-stationery-case-4542804155181` | `amifa-a5-two-zipper-net-stationery-case-4542804155181` | Expected fix; restores canonical A5 listing. |
| `4542804155198Green` | `amifaspecial-b6-two-zipper-net-stationery-case-4542804155198` | `amifa-b6-two-zipper-net-stationery-case-4542804155198` | Expected fix; restores canonical B6 listing. |
| `4542804123555Opaque` | `amifa-masterpiece-collection-a4-collage-paper-8-15-4542804123555` | `amifa-masterpiece-collection-a4-collage-paper-8-15-4542804123555` | Unchanged; split between Opaque and true Transparent JAN remains correct. |
| `4542804044119Blue` | `masking-tape-15mm-geometric-4542804044119` | `amifa-watercolor-masking-tape-4542804044119` | Expected fix; preserves target item's existing listing handle. |
| `4542804044119Yellow` | `masking-tape-15mm-geometric-4542804044119` | `amifa-watercolor-masking-tape-4542804044119` | Expected fix; preserves target item's existing listing handle. |
| `4542804104370Beige` | `design-paper-art-cards-literature-4542804104370` | `design-paper-art-cards-literature-4542804104370 ` | Expected fix by the reducer rule; preserves the target mapping that already existed in replay state, including its trailing-space handle. |

The formal report lists 8 listing-detail label changes. These are the visible
UI effects of correcting stale handle ownership; it reports 0 `Default` label
regressions.

## Replay Noise

The full diff includes 26 `photos` leaf changes and several listing image ID
changes. These are synthetic replay artifacts: generated photo IDs and replay
time `creationTime` values differ between the two captures. They do not indicate
a product, listing, inventory, cost, order, or accounting change.

## Verification

Targeted tests:

```bash
bunx vitest run tests/unit/listing-handle-sync.test.ts
```

Repository checks:

```bash
npm run ci
```

Both passed.
