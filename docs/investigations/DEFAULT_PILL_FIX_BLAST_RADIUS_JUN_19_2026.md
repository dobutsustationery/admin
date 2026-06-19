# Default Pill Fix Blast Radius (Jun 19, 2026)

This report isolates the Default-pill fix against the branch tip after `fef9e4a` (`Improve full-state blast radius reporting`). It uses the Jun 18 production backup and compares the pre-fix replay capture to a fresh replay of the working tree after the fix.

## Commands

Capture fixed state:

```sh
bun scripts/inventory-replay-dump.ts capture \
  --backup ../production-backup-jun-18 \
  --out .blastradius/runs/default-pill-fix-vs-tooling-tip/working-tree-fixed.json \
  --app-root .
```

Generate concise diff:

```sh
bun scripts/inventory-replay-dump.ts diff \
  .blastradius/runs/main-vs-branch-jun-19-full-state/working-tree.json \
  .blastradius/runs/default-pill-fix-vs-tooling-tip/working-tree-fixed.json \
  --out .blastradius/runs/default-pill-fix-vs-tooling-tip/report.md
```

Artifacts:

- `.blastradius/runs/default-pill-fix-vs-tooling-tip/report.md`
- `.blastradius/runs/default-pill-fix-vs-tooling-tip/report.full-state-diff.json`
- `.blastradius/runs/default-pill-fix-vs-tooling-tip/working-tree-fixed.json`

## Summary Judgment

The fix is targeted and appears beneficial. It changes only listing/photo display state and leaves inventory, orders, cost ledger, item history, and inventory value unchanged.

The important result is that the listing-detail `Default` regression is gone:

| Metric | Before fix | After fix | Judgment |
|---|---:|---:|---|
| New high-risk `Default` regressions reported by the diff tool | 0 | 0 | Expected. |
| Visible pill text changes to `Default` | 0 | 1 | Needs review; see `4902778028223` below. |
| Handles whose existing `Default` label was removed | 0 | 29 | Beneficial. |
| Neko Cats `4582608265532` label | `Default` | `Pink` | Beneficial. |
| Inventory item changes | 0 | 0 | Expected. |
| Cost ledger changes | 0 | 0 | Expected. |
| Inventory value JPY delta | 0 | 0 | Expected. |

## Cause And Fix

There were two related reducer problems:

1. When an item key moved, `listings.idToHandle` followed the new key but `handleToListing[handle].variantOptionsByItemId` did not. A listing could therefore point at the bare JAN while the option label was still attached to the old `JAN+Subtype` key, or missing entirely.
2. During Shopify import, a MATCH row could queue `set_variant_option` before the same batch queued `create_listing`. The reducer skipped the option update because the listing did not exist yet. If that row was the first variant, its option label was lost; later variants worked because the listing had been created by then.

The fix makes listing item-key migrations move the option label with the item key, and makes import-created listings merge with existing listing state instead of replacing already-applied variant options. It also defers `set_variant_option` updates until after same-batch listing creation when needed.

## Fix-Only State Diff

| Slice | Added leaves | Removed leaves | Changed leaves | Total | Judgment |
|---|---:|---:|---:|---:|---|
| `listings` | 444 | 75 | 15 | 534 | Expected. Option labels are now preserved for first variants and key moves. |
| `photos` | 32 | 32 | 18 | 82 | Expected secondary effect. Backfilled synthetic photos now use preserved option labels for their photo groups; synthetic IDs/timestamps also vary by replay. |

There are **277** listing variant/option leaf diffs and **190** listing-detail label diffs. The high count is expected because the fix fills option labels that were previously falling back to inventory subtype. Most visible labels do not change text; they gain explicit provenance from `variantOptionsByItemId`.

## Representative Checks

| Handle | Before | After | Judgment |
|---|---|---|---|
| `seal-do-washi-tape-neko-cats-kawaii-4582608265532` | `4582608265501=Gold`; `4582608265532=Default` | `4582608265501=Gold`; `4582608265532=Pink` | Beneficial. |
| `amifa-berry-cherry-wall-stickers-55-4542804113471` | `4542804113471=Default` | `4542804113471=red` | Beneficial in that Default is removed; casing/source data should be reviewed separately. |
| `amifa-masterpiece-collection-b6-clear-folder-3-4542804147667` | `4542804147667=Default` | `4542804147667=Pink` | Beneficial. |

## Visible Pill Text Changes

There are **58** visible pill text changes. This excludes provenance-only changes where the displayed text is unchanged but the label now comes from `variantOptionsByItemId` instead of falling back to `item.subtype`.

Most changes are beneficial `Default -> actual option` repairs. The remaining changes are places where Shopify option text differs from inventory subtype text, or where preserving option labels also exposes a listing handle move. These are display-only changes; inventory, orders, cost ledger, and value are unchanged.

One row, `uni-kuru-toga-0-5mm-mechanical-pencil` / `4902778028223`, changes from `Silver` to `Default`. That is the only visible new `Default` label found by this fix-only comparison. It should be reviewed separately, but it does not affect inventory or valuation.

| Handle | Item | Before | After |
|---|---|---|---|
| `amifa-animal-flake-stickers-100-4542804141160` | `4542804141160Rabbit` | `Rabbit` | `Bunny` |
| `amifa-animal-talk-planner-stickers-90-4542804148121` | `4542804148121Cat` | `Cat` | `Cats` |
| `amifa-animal-talk-planner-stickers-90-4542804148121` | `4542804148121Dog` | `Dog` | `Dogs` |
| `amifa-aurora-clear-sticky-notes-4542804116380` | `4542804116380Blue` | `Blue` | `—` |
| `amifa-aurora-clear-sticky-notes-4542804116380` | `4542804116380Purple` | `Purple` | `—` |
| `amifa-aurora-clear-sticky-notes-75-4542804116380` | `4542804116380Purple` | `—` | `Purple` |
| `amifa-berry-cherry-wall-stickers-55-4542804113471` | `4542804113471` | `Default` | `red` |
| `amifa-cake-masking-tape-4542804106312` | `4542804106312Brown` | `Brown` | `—` |
| `amifa-cake-masking-tape-4542804106312` | `4542804106312Green` | `Green` | `—` |
| `amifa-cake-masking-tape-4542804106312` | `4542804106312Pink` | `Pink` | `—` |
| `amifa-cake-masking-tape-4542804106312` | `4542804106312Yellow` | `Yellow` | `—` |
| `amifa-cake-washi-masking-tape-4542804106312` | `4542804106312Brown` | `—` | `Brown` |
| `amifa-decorative-wax-paper-for-food-with-bears-12-4542804129854` | `4542804129854Beige` | `Beige` | `Bear 2` |
| `amifa-decorative-wax-paper-for-food-with-bears-12-4542804129854` | `4542804129854Plaid` | `Plaid` | `Bear 1` |
| `amifa-fluffy-shima-enaga-bird-desk-tray-4542804121094` | `4542804121094Purple` | `Purple` | `Beige` |
| `amifa-fluffy-shima-enaga-memo-pad-4542804140415` | `4542804140415Beige` | `Beige` | `Brown` |
| `amifa-forest-friends-stickers-56-61-4542804141146` | `4542804141146Rabbit` | `Rabbit` | `Bunny` |
| `amifa-kawaii-planner-stickers-150-4542804154290` | `4542804154290Cat` | `Cat` | `Cats` |
| `amifa-kawaii-planner-stickers-150-4542804154290` | `4542804154290Dog` | `Dog` | `Dogs` |
| `amifa-masterpiece-collection-b6-clear-folder-3-4542804147667` | `4542804147667` | `Default` | `Pink` |
| `amifa-masterpiece-collection-design-sheet-stickers-4542804119848` | `4542804119848` | `Default` | `Masterpiece 1` |
| `amifa-mystic-sky-celestial-stickers-18-4542804141122` | `4542804141122Green` | `Green` | `Teal` |
| `amifaspecial-a4-two-zipper-net-stationery-case-4542804155174` | `4542804155143Purple` | `Purple` | `Blue` |
| `dobutsu-rare-animal-stickers-4542804155570` | `4542804155570Hippo` | `Hippo` | `Capybara` |
| `flake-stickers-animals-40ct-4580424664942` | `4580424664942Marine` | `Marine` | `Land` |
| `furukawa-mini-washi-paper-letter-set` | `4952270287215` | `Default` | `Sakura-Fuji` |
| `furukawa-museum-animals-botticelli` | `4952270291342` | `Default` | `Memo Pad` |
| `furukawa-museum-animals-munch` | `4952270291359` | `Default` | `Memo Pad` |
| `furukawa-museum-animals-vermeer` | `4952270291366` | `Default` | `Memo Pad` |
| `furukawa-retro-cat-dog-washi-flake-stickers` | `4952270275366` | `Default` | `Cat` |
| `furukawa-sora-cafe-dark-blue-bear` | `4952270292042` | `Default` | `Flake Stickers` |
| `furukawa-sora-cafe-light-blue-sheep` | `4952270292028` | `Default` | `Flake Stickers` |
| `furukawa-sora-cafe-rose-pink-cat` | `4952270292035` | `Default` | `Flake Stickers` |
| `ilmily-pilot-0-5mm-gel-ink-pen-nuance-black-collection` | `4902505660405` | `Default` | `Blue` |
| `king-jim-coffret-film-stickers` | `4971660060610` | `Default` | `Triangles` |
| `king-jim-kitta-washi-tape-precut` | `4971660042500` | `Default` | `Cats` |
| `kobaru-retro-card-set` | `4560103149144` | `Default` | `Bear` |
| `kyowa-kawaii-puppy-dog-love-fur-a5-notebook-4969757173343` | `4969757173343Pomeranian` | `Pomeranian` | `Maltese` |
| `letter-set-4580424665277` | `4580424665277Pink` | `Default` | `Pink` |
| `nippon-notebook-17-9-x-12-6-mm` | `4901470099159` | `Default` | `Grid` |
| `papier-platz-memo-pad-animals` | `4520491375105` | `Default` | `Bird` |
| `pilot-frixion-erasable-highlighter-set` | `4902505596698` | `Default` | `Natural` |
| `pilot-ilmily-two-colour-ballpoint-pen` | `4902505648977` | `Default` | `—` |
| `pilot-ilmily-two-colour-ballpoint-pen` | `4902505648984` | `Navy/Gray` | `—` |
| `pilot-ilmily-two-colour-ballpoint-pen` | `4902505648991` | `Emerald/Mint` | `—` |
| `pilot-ilmily-two-colour-ballpoint-pen` | `4902505649004` | `Grape/Lavender` | `—` |
| `pilot-ilmily-two-colour-ballpoint-pen-04-mm-4902505648977` | `4902505648977` | `—` | `Wine Red/Gray` |
| `pilot-juice-0-5mm-6-pen-set` | `4902505673924` | `Default` | `Retro` |
| `plus-deco-rush-decoration-tape-4m` | `4977564720711` | `Default` | `Lightbulbs` |
| `plus-norino-doublesided-glue-tape-12m` | `4977564690045` | `Default` | `Pink` |
| `plus-twiggy-pocket-scissors` | `4977564613341` | `Default` | `Blue` |
| `seal-do-washi-tape-neko-cats-kawaii-4582608265532` | `4582608265532` | `Default` | `Pink` |
| `uni-kuru-toga-0-5mm-mechanical-pencil` | `4902778028179` | `Default` | `Black` |
| `uni-kuru-toga-0-5mm-mechanical-pencil` | `4902778028223` | `Silver` | `Default` |
| `uni-propus-window-highlighter-set` | `4902778133583` | `Default` | `Light` |
| `zebra-clickart-12-color-marker-set` | `4901681382316` | `Default` | `Standard` |
| `zebra-fineliner-double-sided-marker-0-3mm-0-7mm` | `4901681551118` | `Default` | `Black` |
| `zebra-sarasa-clip-milk-color-pen` | `4901681413713` | `Default` | `White` |

## Non-Impacts

The generated report confirms:

- `inventory.idToItem`: 0 added, 0 removed, 0 changed.
- `inventory.costLedger`: 0 added, 0 removed, 0 changed.
- `inventory.idToHistory`: 0 changed.
- `orderLines`: unchanged at 2,078.
- Total inventory value: unchanged at JPY 815,807.65 / EUR 4,758.9352.
- Average cost changes: 0.
- Received cost-basis changes: 0.

## Recommendation

This fix removes the blocker identified in [BRANCH_IMPACT_JUN_19_2026.md](./BRANCH_IMPACT_JUN_19_2026.md). The remaining review question is whether all Shopify option labels should be treated as authoritative display labels where they differ from inventory subtypes. That is separate from the Default-pill regression and does not affect inventory valuation or cost accounting.
