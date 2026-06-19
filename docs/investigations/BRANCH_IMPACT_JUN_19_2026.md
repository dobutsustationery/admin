# Branch Impact Report: Full Redux State Coverage (Jun 19, 2026)

This report supersedes [BRANCH_IMPACT_JUN_17_2026.md](./BRANCH_IMPACT_JUN_17_2026.md) for coverage, not for every conclusion. The Jun 17 report only compared `state.inventory`, which missed UI-visible changes outside inventory. The blind spot mattered: listing-detail pages can now show a variant pill labeled `Default` where the old state showed the real option label.

## Reproduction

Baseline command:

```sh
npm run blast-radius -- compare --base main --head working-tree \
  --backup ../production-backup-jun-18 --name main-vs-branch-jun-19-full-state \
  --skip-install
```

Artifacts:

- Concise generated report: `.blastradius/runs/main-vs-branch-jun-19-full-state/report.md`
- Exhaustive leaf diff JSON: `.blastradius/runs/main-vs-branch-jun-19-full-state/report.full-state-diff.json`
- Base capture: `.blastradius/runs/main-vs-branch-jun-19-full-state/460e3cc5d6a9.json`
- Branch capture: `.blastradius/runs/main-vs-branch-jun-19-full-state/working-tree.json`

For full Markdown details, run:

```sh
bun scripts/inventory-replay-dump.ts diff \
  .blastradius/runs/main-vs-branch-jun-19-full-state/460e3cc5d6a9.json \
  .blastradius/runs/main-vs-branch-jun-19-full-state/working-tree.json \
  --out .blastradius/runs/main-vs-branch-jun-19-full-state/report.full.md \
  --detail-limit 0
```

## Executive Summary

The tooling now captures the complete replayed Redux state and writes an exhaustive leaf-path diff. That closes the specific blind spot that hid listing-detail changes.

The branch is still not ready to land. Most inventory and cost-ledger changes are the expected consequences of the branch work already reviewed, but the full-state pass found a harmful listing regression: **28 listing detail pages now have at least one variant label falling back to `Default`**. The user-visible example is `seal-do-washi-tape-neko-cats-kawaii-4582608265532`, where `Pink` becomes `Default`.

The likely fix is not to suppress the report. The reducer/import path that normalizes single inventory keys to bare JANs must preserve the listing option label for every item attached to a multi-variant listing.

## Coverage

The old report could only talk about inventory. The new comparison saw **57,084** leaf diffs across the full state.

| Slice | Added | Removed | Changed | Total | Judgment |
|---|---:|---:|---:|---:|---|
| `inventory` | 23,251 | 19,069 | 13,479 | 55,799 | Expected/mixed. Mostly known branch effects: key normalization, cost-ledger authority, archive and Japan Festival recalculation. |
| `listings` | 946 | 153 | 15 | 1,114 | Mixed. Preserved `variantOptionsByItemId` is beneficial, but missing labels create a blocker. |
| `photos` | 64 | 64 | 14 | 142 | Expected/unknown. Mostly photo keys moving from `JAN:Subtype` to bare `JAN`, plus synthetic id/timestamp churn. Needs review but not the primary blocker. |
| `keyAudit` | 0 | 28 | 0 | 28 | Expected. Ghost-map entries disappear where canonical key handling changes. |
| `schemaVersion` | 0 | 0 | 1 | 1 | Expected. Branch schema version changed `13 -> 15`. |

## Landing Judgment

| Area | Status | Evidence | Next Action |
|---|---|---|---|
| Full-state blast-radius coverage | Expected and beneficial | Captures all Redux slices and writes `report.full-state-diff.json`. | Keep. This should replace inventory-only blast-radius reports. |
| Concise report generation | Expected and beneficial | Markdown defaults to 20 examples per broad table and gives a command for full detail. | Keep. Use full Markdown only for deep audit follow-up. |
| Inventory/cost-ledger impacts | Expected/mixed | Same broad profile as Jun 17: 1,306 items unchanged, 15 order lines added, 55 fewer history keys, 23 cost-ledger keys with materialized open value changes. | Continue reviewing known cost-ledger deltas separately, but no new blocker found by this pass. |
| Listing option preservation | Unexpected and harmful/blocker | 277 listing-detail label changes; 28 introduce a `Default` label. | Fix before landing. |
| Photo state changes | Unexpected/unknown | 142 photo leaf diffs, mostly key moves and synthetic metadata. | Spot-check after listing fix; likely acceptable if visual images still follow normalized keys. |

## Listing Regression

The report now derives the labels the listing-detail UI will render:

```ts
liveListing.variantOptionsByItemId?.[id] || item.subtype || "Default"
```

This is the right thing to check because the bad `Default` pill is not stored directly. It appears when both sources of a label are missing.

Summary:

| Metric | Count | Judgment |
|---|---:|---|
| Listing-detail pages with any label change | 277 | Mostly expected after key normalization and option preservation. |
| Listing-detail pages with a new `Default` label | 28 | Harmful/blocker. |
| Listing variant/option leaf diffs | 695 | Mixed: many are beneficial additions of `variantOptionsByItemId`; missing entries are the problem. |

Representative blocker:

| Handle | Before | After | Judgment |
|---|---|---|---|
| `seal-do-washi-tape-neko-cats-kawaii-4582608265532` | `4582608265501Gold=Gold`; `4582608265532Pink=Pink` | `4582608265501=Gold`; `4582608265532=Default` | Harmful. `Pink` was lost when `4582608265532Pink` normalized to bare `4582608265532`. |

Other examples, limited to 20 rows:

| Handle | Problem |
|---|---|
| `amifa-berry-cherry-wall-stickers-55-4542804113471` | New bare item renders `Default`. |
| `amifa-masterpiece-collection-design-sheet-stickers-4542804119848` | `Masterpiece 1` renders `Default`. |
| `furukawa-mini-washi-paper-letter-set` | `Sakura-Fuji` item renders `Default`. |
| `furukawa-museum-animals-botticelli` | `Memo Pad` item renders `Default`. |
| `furukawa-museum-animals-munch` | `Memo Pad` item renders `Default`. |
| `furukawa-museum-animals-vermeer` | `Memo Pad` item renders `Default`. |
| `furukawa-retro-cat-dog-washi-flake-stickers` | `Cat` item renders `Default`. |
| `furukawa-sora-cafe-dark-blue-bear` | `Flake Stickers` item renders `Default`. |
| `furukawa-sora-cafe-light-blue-sheep` | `Flake Stickers` item renders `Default`. |
| `furukawa-sora-cafe-rose-pink-cat` | `Flake Stickers` item renders `Default`. |
| `ilmily-pilot-0-5mm-gel-ink-pen-nuance-black-collection` | `Blue` item renders `Default`. |
| `king-jim-coffret-film-stickers` | `Triangles` item renders `Default`. |
| `king-jim-kitta-washi-tape-precut` | `Cats` item renders `Default`. |
| `kobaru-retro-card-set` | `Bear` item renders `Default`. |
| `nippon-notebook-17-9-x-12-6-mm` | `Grid` item renders `Default`. |
| `papier-platz-memo-pad-animals` | `Bird` item renders `Default`. |
| `pilot-frixion-erasable-highlighter-set` | `Natural` item renders `Default`. |
| `pilot-ilmily-two-colour-ballpoint-pen` | `Wine Red/Gray` item renders `Default`. |
| `pilot-juice-0-5mm-6-pen-set` | `Retro` item renders `Default`. |
| `plus-deco-rush-decoration-tape-4m` | `Lightbulbs` item renders `Default`. |

There are 8 more default regressions. Generate the full Markdown report with the command above, or inspect `report.full-state-diff.json`, before signing off.

## Inventory And Cost Summary

The inventory/cost numbers still match the shape of the prior branch report, with minor count differences because this run uses the Jun 18 backup rather than the Jun 11 backup.

| Metric | Main | Branch | Delta | Judgment |
|---|---:|---:|---:|---|
| Inventory items | 1,306 | 1,306 | 0 | Expected. |
| Cost ledger keys | 1,305 | 1,305 | 0 | Expected. |
| Orders | 101 | 101 | 0 | Expected. |
| Order lines | 2,063 | 2,078 | +15 | Expected from bare-JAN Shopify order-line binding. |
| History keys | 1,542 | 1,487 | -55 | Expected key normalization churn, but still worth spot-checking migrations. |
| Missing country of origin | 398 | 398 | 0 | Expected. |
| Missing weight | 398 | 398 | 0 | Expected. |

Visible on-hand changes are small enough to list directly:

| Key | On hand main -> branch | Judgment |
|---|---:|---|
| `4589469849758` | `-7 -> 0` | Expected from cost-ledger-authoritative visible count. |
| `4542804080773Cream` | `-6 -> 0` | Expected from cost-ledger-authoritative visible count. |
| `4991685190055Pink` | `-3 -> 2` | Expected found-stock correction. |
| `4991685190055White` | `1 -> 6` | Expected found-stock correction. |
| `4991685201126Black` | `-1 -> 4` | Expected found-stock correction. |
| `4991685201126White` | `-3 -> 2` | Expected found-stock correction. |
| `4542804149982Yellow` | `-2 -> 0` | Expected from cost-ledger-authoritative visible count. |
| `4542804113679Black` | `-1 -> 0` | Expected from cost-ledger-authoritative visible count. |
| `4542804117776Beige` | `14 -> 13` | Expected from Japan Festival/archive recalculation. |
| `4542804130904Swan` | `22 -> 21` | Expected from Japan Festival/archive recalculation. |

Inventory value, using the cost engine on all on-hand ledgers:

| Currency | Main | Branch | Delta | Judgment |
|---|---:|---:|---:|---|
| JPY | 820,520.25 | 815,807.65 | -4,712.60 | Expected/mixed. Same kind of movement as Jun 17; driven by quantity and archive recalculation, not the listing blocker. |
| EUR | 4,787.0444 | 4,758.9352 | -28.1092 | Expected/mixed. |

Average cost changes are small enough to list:

| Key | Avg JPY main -> branch | Judgment |
|---|---:|---|
| `4542804108644Purple` | `0 -> 65` | Expected correction: uncosted position gains the proper basis. |
| `4542804109153Green` | `65 -> 0` | Expected/needs domain review: archive and oversold handling remove the open priced basis. |

Received cost-basis changes affect 11 items. The generated report lists them all; these remain part of the known cost-ledger review surface rather than the new full-state blocker.

## Tooling Changes

Two tooling changes are important:

1. `scripts/inventory-replay-dump.ts` now captures full Redux state in `inventory-replay-dump/v2`, while retaining the old `inventory` field for compatibility.
2. `scripts/blast-radius.ts` now runs the current checkout's dumper for both base and head with `--app-root <worktree>`. That ensures one comparison implementation evaluates both reducer versions and avoids false noise from older dump tooling on `main`.

The Markdown generator now defaults to a 20-row detail limit. That is intentional. If a section can be reviewed in 20 rows or fewer, it is listed; if not, the report summarizes the impact and gives the full-detail command.

## Recommendation

Do not land this branch until the 28 `Default` listing-label regressions are fixed or explicitly accepted. The branch impact tooling is now broad enough to catch the problem, and the concise report shape is suitable for review, but the branch behavior is not yet acceptable.
