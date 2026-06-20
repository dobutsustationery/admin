# Default Pill Fix Blast Radius (Jun 19, 2026)

This report isolates the Default-pill fix against the replay capture from before the Default-pill changes. It uses the Jun 18 production backup and compares that pre-fix replay to a fresh replay of the corrected working tree.

## Commands

Capture corrected state:

```sh
bun scripts/inventory-replay-dump.ts capture \
  --backup ../production-backup-jun-18 \
  --out .blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/working-tree-fixed.json \
  --app-root .
```

Generate concise diff:

```sh
bun scripts/inventory-replay-dump.ts diff \
  .blastradius/runs/main-vs-branch-jun-19-full-state/working-tree.json \
  .blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/working-tree-fixed.json \
  --out .blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/report.md
```

Artifacts:

- `.blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/report.md`
- `.blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/report.full-state-diff.json`
- `.blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/working-tree-fixed.json`

For full detail:

```sh
bun scripts/inventory-replay-dump.ts diff \
  .blastradius/runs/main-vs-branch-jun-19-full-state/working-tree.json \
  .blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/working-tree-fixed.json \
  --out .blastradius/runs/default-pill-fix-sticky-handles-vs-pre-default/report.full.md \
  --detail-limit 0
```

## Summary Judgment

The corrected fix is targeted and beneficial. It changes only listing/photo display state and leaves inventory, orders, cost ledger, item history, and inventory value unchanged.

The originally observed blocker is fixed: subtype renames such as `Bunny -> Rabbit` no longer carry the stale old option label forward. If the old listing option merely mirrored the old subtype, the migrated listing option now uses the new subtype label. If the option label was genuinely distinct from the subtype, it is still preserved.

| Metric                                                    | Result | Judgment                                                                            |
| --------------------------------------------------------- | -----: | ----------------------------------------------------------------------------------- |
| Full Redux leaf-path diffs                                |  1,165 | Confined to `listings` and `photos`.                                                |
| Listing variant/option leaf diffs                         |    293 | Expected; option labels are now explicitly preserved/backfilled.                    |
| Listing-detail row diffs                                  |    210 | Includes provenance-only option backfills and sticky-handle listing identity moves. |
| Item-level visible pill text changes                      |     58 | Auditable directly below.                                                           |
| New high-risk `Default` regressions reported by diff tool |      7 | Listing identity moves from enforcing sticky handles; review display separately.    |
| Inventory item changes                                    |      0 | Expected.                                                                           |
| Cost ledger changes                                       |      0 | Expected.                                                                           |
| Item history changes                                      |      0 | Expected.                                                                           |
| Order line changes                                        |      0 | Expected.                                                                           |
| Inventory value JPY delta                                 |      0 | Expected.                                                                           |

## Cause And Fix

There were three related reducer problems:

1. When an item key moved, `listings.idToHandle` followed the new key but `handleToListing[handle].variantOptionsByItemId` did not. A listing could therefore point at the new item key while the option label was still attached to the old key, or missing entirely.
2. During Shopify import, a `MATCH` row could queue `set_variant_option` before the same batch queued `create_listing`. The reducer skipped the option update because the listing did not exist yet. If that row was the first variant, its option label was lost; later variants worked because the listing had been created by then.
3. The first fix preserved stale subtype-derived option labels too aggressively. For example, `4542804141160Bunny` was renamed to `4542804141160Rabbit`, but the explicit listing option `"Bunny"` was migrated to the Rabbit item. The corrected reducer treats an old option equal to the old subtype as subtype-derived and replaces it with the new subtype label.

## Fix-Only State Diff

| Slice      | Added leaves | Removed leaves | Changed leaves | Total | Judgment                                                                                                                                                |
| ---------- | -----------: | -------------: | -------------: | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listings` |          718 |            334 |             31 | 1,083 | Expected mechanically; includes sticky-handle listing identity changes that should be reviewed.                                                         |
| `photos`   |           32 |             32 |             18 |    82 | Expected secondary effect. Backfilled synthetic photos now use preserved option labels for their photo groups; synthetic IDs/timestamps vary by replay. |

## Representative Checks

| Handle                                                | Before                                                                                                   | After                                           | Judgment                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `amifa-animal-flake-stickers-100-4542804141160`       | `4542804141160Rabbit=Rabbit` via item subtype fallback; stale dead-key option `4542804141160Bunny=Bunny` | `4542804141160Rabbit=Rabbit` as explicit option | Beneficial; stale Bunny option is not carried forward.                                   |
| `amifa-animal-talk-planner-stickers-90-4542804148121` | `Cat` and `Dog` via subtype fallback                                                                     | `Cat` and `Dog` as explicit options             | Beneficial; stale `Cats`/`Dogs` options are not carried forward.                         |
| `seal-do-washi-tape-neko-cats-kawaii-4582608265532`   | `4582608265501=Gold`; `4582608265532=Default`                                                            | `4582608265501=Gold`; `4582608265532=Pink`      | Beneficial; the observed Default pill regression is repaired.                            |
| `amifa-berry-cherry-wall-stickers-55-4542804113471`   | `4542804113471=Default`                                                                                  | `4542804113471=red`                             | Beneficial in that Default is removed; casing/source data should be reviewed separately. |

## Visible Pill Text Changes

There are **58** item-level visible pill text changes versus the pre-Default-pill replay. This excludes provenance-only changes where the displayed text is unchanged but the label now comes from `variantOptionsByItemId` instead of falling back to `item.subtype`.

Many changes are beneficial `Default -> actual option` repairs. Rows with `—` are listing handle/key movements. The rows that move to `Default` are not cost/inventory changes; they are listing identity differences caused by enforcing sticky handles instead of title-derived handle regeneration.

| Handle                                                                           | Item                             | Before         | After            |
| -------------------------------------------------------------------------------- | -------------------------------- | -------------- | ---------------- |
| `amifa-berry-cherry-wall-stickers-55-4542804113471`                              | `4542804113471`                  | `Default`      | `red`            |
| `amifa-masterpiece-collection-design-sheet-stickers-4542804119848`               | `4542804119848`                  | `Default`      | `Masterpiece 1`  |
| `books-kinokuniya-sarasa-r-7-color-set-0-4-mm-zebra-jjs29-r1-7c-4901681485406`   | `4901681485406`                  | `—`            | `Default`        |
| `decorative-tape-lightbulb-https://bungu.plus.co.jp/deco/`                       | `https://bungu.plus.co.jp/deco/` | `Default`      | `—`              |
| `decorative-tape-pink-flowers-https://bungu.plus.co.jp/deco/`                    | `https://bungu.plus.co.jp/deco/` | `—`            | `Default`        |
| `diecut-film-seals-32ct-4969757157022`                                           | `4969757157022Green`             | `—`            | `Green`          |
| `diecut-film-seals-green-girl-32ct-4969757157022`                                | `4969757157022Green`             | `Green`        | `—`              |
| `furukawa-mini-washi-paper-letter-set`                                           | `4952270287215`                  | `Default`      | `Sakura-Fuji`    |
| `furukawa-museum-animals-botticelli`                                             | `4952270291342`                  | `Default`      | `Memo Pad`       |
| `furukawa-museum-animals-munch`                                                  | `4952270291359`                  | `Default`      | `Memo Pad`       |
| `furukawa-museum-animals-vermeer`                                                | `4952270291366`                  | `Default`      | `Memo Pad`       |
| `furukawa-retro-cat-dog-washi-flake-stickers`                                    | `4952270275366`                  | `Default`      | `Cat`            |
| `furukawa-sora-cafe-dark-blue-bear`                                              | `4952270292042`                  | `Default`      | `Flake Stickers` |
| `furukawa-sora-cafe-light-blue-sheep`                                            | `4952270292028`                  | `Default`      | `Flake Stickers` |
| `furukawa-sora-cafe-rose-pink-cat`                                               | `4952270292035`                  | `Default`      | `Flake Stickers` |
| `glue-tape-6mm-x-6-5m-4549131268171`                                             | `4549131268171`                  | `—`            | `Default`        |
| `glue-tape-6mm-x-6-5m-green-4549131268171`                                       | `4549131268171`                  | `Default`      | `—`              |
| `glue-tape-6mm-x-7m-yelloe-4549131268195`                                        | `4549131268195`                  | `—`            | `Default`        |
| `glue-tape-6mm-x-7m-yellow-4549131268195`                                        | `4549131268195`                  | `Default`      | `—`              |
| `ilmily-pilot-0-5mm-gel-ink-pen-nuance-black-collection`                         | `4902505660405`                  | `Default`      | `Blue`           |
| `japanese-greeting-card-pink-envelope-4540457802704`                             | `4540457802704Blue`              | `—`            | `Blue`           |
| `japanese-greeting-card-with-envelope-4540457802704`                             | `4540457802704Blue`              | `Blue`         | `—`              |
| `king-jim-coffret-film-stickers`                                                 | `4971660060610`                  | `Default`      | `Triangles`      |
| `king-jim-kitta-washi-tape-precut`                                               | `4971660042500`                  | `Default`      | `Cats`           |
| `kobaru-retro-card-set`                                                          | `4560103149144`                  | `Default`      | `Bear`           |
| `letter-set-with-envelopes-4582686710160`                                        | `4582686710160Orange`            | `Orange`       | `—`              |
| `letter-set-with-envelopes-dogs-4582686710160`                                   | `4582686710160Orange`            | `—`            | `Orange`         |
| `mini-card-set-animals-with-envelope-4512427012826`                              | `4512427012826Blue`              | `—`            | `Blue`           |
| `mini-card-set-animals-with-envelope-4512427064481`                              | `4512427064481Green`             | `Green`        | `—`              |
| `mini-card-set-animals-with-transparent-envelope-4512427064481`                  | `4512427064481Green`             | `—`            | `Green`          |
| `mini-card-set-with-envelope-4510085530928`                                      | `4510085530928Yellow`            | `Yellow`       | `—`              |
| `mini-card-set-with-transparent-envelope-4510085530928`                          | `4510085530928Yellow`            | `—`            | `Yellow`         |
| `mini-letter-set-4512427012826`                                                  | `4512427012826Blue`              | `Blue`         | `—`              |
| `nippon-notebook-17-9-x-12-6-mm`                                                 | `4901470099159`                  | `Default`      | `Grid`           |
| `papier-platz-memo-pad-animals`                                                  | `4520491375105`                  | `Default`      | `Bird`           |
| `pilot-frixion-erasable-highlighter-set`                                         | `4902505596698`                  | `Default`      | `Natural`        |
| `pilot-ilmily-two-colour-ballpoint-pen`                                          | `4902505648977`                  | `Default`      | `Wine Red/Gray`  |
| `pilot-juice-0-5mm-6-pen-set`                                                    | `4902505673924`                  | `Default`      | `Retro`          |
| `pilot-juice-0-5mm-water-based-pigment-gel-ink-4902505665301`                    | `4902505665301`                  | `Default`      | `—`              |
| `pilot-juice-0-5mm-water-based-pigment-gel-ink-ballpen-10th-4902505665301`       | `4902505665301`                  | `—`            | `Default`        |
| `plus-deco-rush-decoration-tape-4m`                                              | `4977564720711`                  | `Default`      | `Lightbulbs`     |
| `plus-norino-doublesided-glue-tape-12m`                                          | `4977564690045`                  | `Default`      | `Pink`           |
| `plus-twiggy-pocket-scissors`                                                    | `4977564613341`                  | `Default`      | `Blue`           |
| `point-stickers-antique-4580424665406`                                           | `4580424665406Antique`           | `Antique`      | `—`              |
| `point-stickers-antique-4580424665406`                                           | `4580424665406Round/strips`      | `Round/strips` | `—`              |
| `point-stickers-antique-bears-68ct-4580424665406`                                | `4580424665406Antique`           | `—`            | `Antique`        |
| `point-stickers-antique-bears-72ct-4580424665406`                                | `4580424665406Round/strips`      | `—`            | `Round/strips`   |
| `sarasa-clip-limited-edition-cat-design-a-4901681227518`                         | `4901681227518`                  | `Default`      | `—`              |
| `sarasa-clip-limited-edition-jj15-5c-vi-cata-cat-design-a-4901681227518`         | `4901681227518`                  | `—`            | `Default`        |
| `sarasa-r-7-color-set-0-4-mm-zebra-4901681485406`                                | `4901681485406`                  | `Default`      | `—`              |
| `seal-do-washi-tape-neko-cats-kawaii-4582608265532`                              | `4582608265532`                  | `Default`      | `Pink`           |
| `uni-kuru-toga-0-5mm-mechanical-pencil`                                          | `4902778028179`                  | `Default`      | `Black`          |
| `uni-propus-window-highlighter-set`                                              | `4902778133583`                  | `Default`      | `Light`          |
| `zebra-clickart-12-color-marker-set`                                             | `4901681382316`                  | `Default`      | `Standard`       |
| `zebra-fineliner-double-sided-marker-0-3mm-0-7mm`                                | `4901681551118`                  | `Default`      | `Black`          |
| `zebra-gel-ballpoint-pen-sarasa-clip-0-4-10-colors-4901681716500`                | `4901681716500`                  | `Default`      | `—`              |
| `zebra-gel-ballpoint-pen-sarasa-clip-0-4-10-colors-jjs15-10ca-for-4901681716500` | `4901681716500`                  | `—`            | `Default`        |
| `zebra-sarasa-clip-milk-color-pen`                                               | `4901681413713`                  | `Default`      | `White`          |

## Corrected Subtype-Rename Regressions

Compared to the first Default-pill fix attempt, these stale option-label migrations are corrected:

| Handle                                                            | Item                      | First attempt | Corrected    | Judgment                                                   |
| ----------------------------------------------------------------- | ------------------------- | ------------- | ------------ | ---------------------------------------------------------- |
| `amifa-animal-flake-stickers-100-4542804141160`                   | `4542804141160Rabbit`     | `Bunny`       | `Rabbit`     | Corrects subtype rename.                                   |
| `amifa-animal-talk-planner-stickers-90-4542804148121`             | `4542804148121Cat`        | `Cats`        | `Cat`        | Corrects subtype rename.                                   |
| `amifa-animal-talk-planner-stickers-90-4542804148121`             | `4542804148121Dog`        | `Dogs`        | `Dog`        | Corrects subtype rename.                                   |
| `amifa-decorative-wax-paper-for-food-with-bears-12-4542804129854` | `4542804129854Beige`      | `Bear 2`      | `Beige`      | Corrects stale subtype-derived label.                      |
| `amifa-decorative-wax-paper-for-food-with-bears-12-4542804129854` | `4542804129854Plaid`      | `Bear 1`      | `Plaid`      | Corrects stale subtype-derived label.                      |
| `amifa-fluffy-shima-enaga-bird-desk-tray-4542804121094`           | `4542804121094Purple`     | `Beige`       | `Purple`     | Corrects stale subtype-derived label.                      |
| `amifa-fluffy-shima-enaga-memo-pad-4542804140415`                 | `4542804140415Beige`      | `Brown`       | `Beige`      | Corrects stale subtype-derived label.                      |
| `amifa-forest-friends-stickers-56-61-4542804141146`               | `4542804141146Rabbit`     | `Bunny`       | `Rabbit`     | Corrects subtype rename.                                   |
| `amifa-kawaii-planner-stickers-150-4542804154290`                 | `4542804154290Cat`        | `Cats`        | `Cat`        | Corrects subtype rename.                                   |
| `amifa-kawaii-planner-stickers-150-4542804154290`                 | `4542804154290Dog`        | `Dogs`        | `Dog`        | Corrects subtype rename.                                   |
| `amifa-masterpiece-collection-b6-clear-folder-3-4542804147667`    | `4542804147667`           | `Pink`        | `Default`    | Removes a stale option for a bare item; review separately. |
| `amifa-mystic-sky-celestial-stickers-18-4542804141122`            | `4542804141122Green`      | `Teal`        | `Green`      | Corrects stale subtype-derived label.                      |
| `amifaspecial-a4-two-zipper-net-stationery-case-4542804155174`    | `4542804155143Purple`     | `Blue`        | `Purple`     | Corrects stale subtype-derived label.                      |
| `dobutsu-rare-animal-stickers-4542804155570`                      | `4542804155570Hippo`      | `Capybara`    | `Hippo`      | Corrects stale subtype-derived label.                      |
| `flake-stickers-animals-40ct-4580424664942`                       | `4580424664942Marine`     | `Land`        | `Marine`     | Corrects stale subtype-derived label.                      |
| `kyowa-kawaii-puppy-dog-love-fur-a5-notebook-4969757173343`       | `4969757173343Pomeranian` | `Maltese`     | `Pomeranian` | Corrects stale subtype-derived label.                      |

## Listing Handle Movements

Several visible pill rows are listing handle movements, not subtype-label corrections. The handles do not appear as persisted broadcast payloads in the Jun 18 backup; they are synthesized during replay from Shopify import/listing creation data.

| JAN             | Before sticky-handle fix                                                                                                           | After sticky-handle fix                                                                                        | What is happening                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `4542804116380` | Purple moved to synthesized `amifa-aurora-clear-sticky-notes-75-4542804116380`; Blue stayed on the imported/catalog handle.        | Blue and Purple both stay on explicit imported/catalog handle `amifa-aurora-clear-sticky-notes-4542804116380`. | Broadcast action `uNiufMChfga40okqyr9Y` (`2026-05-11T13:55:29.463Z`) is a no-op-looking `update_field description` for Purple. The old listings reducer regenerated the handle from title+JAN and moved only Purple. |
| `4542804106312` | Brown moved to synthesized `amifa-cake-washi-masking-tape-4542804106312`; Pink/Green/Yellow stayed on the imported/catalog handle. | Pink/Brown/Green/Yellow all stay on explicit imported/catalog handle `amifa-cake-masking-tape-4542804106312`.  | Broadcast action `OIGyFfqnTiCbjNLZTSpt` (`2026-05-12T17:37:46.926Z`) is a no-op-looking `update_field description` for Brown. The old listings reducer regenerated the handle from title+JAN and moved only Brown.   |

These two specific partial moves are fixed. The remaining handle-movement rows in the visible table are the broader consequence of enforcing the same sticky-handle rule wherever the old replay would have derived a handle from title+JAN.

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

This corrected fix removes the blocker identified in [BRANCH_IMPACT_JUN_19_2026.md](./BRANCH_IMPACT_JUN_19_2026.md), avoids preserving stale subtype labels, and enforces sticky handles for description edits. The remaining review questions are listing identity/display questions, not inventory valuation or cost accounting questions.
