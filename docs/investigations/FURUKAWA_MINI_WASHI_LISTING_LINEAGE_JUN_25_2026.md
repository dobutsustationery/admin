# Furukawa Mini Washi Paper Letter Set Listing Lineage

Date: 2026-06-25

## Scope

Investigate the listing:

```text
furukawa-mini-washi-paper-letter-set
```

The question was specifically to audit every case where either the visible
order or the labels on the listing's subtype pills changed, using a replay of
the full production backup.

This is a read-only investigation. No reducer, UI, or production data changes
were made for this trace.

## Method

Dataset:

```text
../production-backup-jun-23/firestore-export.json
```

Replay method:

- Replayed all `41,963` broadcast actions through the current `rootReducer`.
- Replay errors: `0`.
- After every action, captured:
  - live listing rows for `listings.handleToListing["furukawa-mini-washi-paper-letter-set"]`
  - draft proposal rows for the JANs that later became part of this listing
- For live listing rows, matched the `listing-detail` route's current behavior:
  - rows come from `listings.idToHandle`
  - visible label is `listing.variantOptionsByItemId[itemId] || item.subtype || "Default"`
  - visible order is `imagePosition`, then label

Temporary trace artifacts generated during the investigation:

```text
/tmp/furukawa-mini-washi-lineage.json
/tmp/furukawa-mini-washi-broader-lineage.json
```

## Final Replay State

The listing has 7 live subtype pills:

| Order | Label            | Item key        | JAN             | `imagePosition` | Qty | Shipped |
| ----: | ---------------- | --------------- | --------------- | --------------: | --: | ------: |
|     1 | `Cat/Flower`     | `4952270302420` | `4952270302420` |               1 |  10 |       1 |
|     2 | `Sakura-Fuji`    | `4952270287215` | `4952270287215` |               2 |   4 |       1 |
|     3 | `Strolling Cats` | `4952270287420` | `4952270287420` |               3 |  10 |       6 |
|     4 | `Cat`            | `4952270287321` | `4952270287321` |               4 |  11 |       3 |
|     5 | `Dog`            | `4952270287277` | `4952270287277` |               5 |   3 |       1 |
|     6 | `Sakura`         | `4952270287444` | `4952270287444` |               6 |   4 |       1 |
|     7 | `Hedgehog`       | `4952270287253` | `4952270287253` |               7 |   5 |       1 |

The important detail is that all final inventory rows are bare JAN rows
(`subtype: ""`). The labels above come from
`listing.variantOptionsByItemId`, not from inventory item subtypes.

Final `variantOptionsByItemId`:

```json
{
  "4952270287215": "Sakura-Fuji",
  "4952270287253": "Hedgehog",
  "4952270287277": "Dog",
  "4952270287321": "Cat",
  "4952270287444": "Sakura",
  "4952270302420": "Cat/Flower",
  "4952270287420": "Strolling Cats"
}
```

## Timeline Of Visible Pill Changes

### 1. Shopify import created the first live listing

| Field   | Value                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------------- |
| Time    | `2026-03-02T20:42:01.828Z`                                                                                |
| Action  | `shopifyImport/import_batch`                                                                              |
| Doc id  | `QXjOPCeVsEaTfY1KvmSb`                                                                                    |
| Options | `useShopifyDescription`, `useShopifyImages`, `useShopifyHandles`, `useShopifyWeights`, `ignoreShopifyQty` |

Visible live listing before:

```text
(none)
```

Visible live listing after:

```text
Cat
Dog
Hedgehog
Sakura
Sakura-Fuji
```

This created the initial 5-pill local listing from Shopify data.

### 2. Listing creation generated draft proposals for two additional JANs

| Field  | Value                           |
| ------ | ------------------------------- |
| Time   | `2026-03-17T18:37:22.422Z`      |
| Action | `listingCreation/add_proposals` |
| Doc id | `rOwm7mlHedPLyzz5HaPp`          |

Relevant draft rows after proposal generation:

```text
proposal 4952270287420 (no handle)
  Default
proposal 4952270302420 (no handle)
  Default
```

These were not live listing pills yet, but they are part of the lineage because
they later merged into the shared listing.

### 3. The primary draft was pointed at the existing listing handle

| Field  | Value                                                          |
| ------ | -------------------------------------------------------------- |
| Time   | `2026-03-17T18:45:00.277Z`                                     |
| Action | `listingCreation/update_proposal_field`                        |
| Doc id | `AbUMgawrzijjlKTcFHqF`                                         |
| Edit   | `4952270302420 handle -> furukawa-mini-washi-paper-letter-set` |

This changed the draft proposal's target handle, but did not yet change live
listing pills.

### 4. Existing variants were imported into the primary draft

| Field   | Value                                                                    |
| ------- | ------------------------------------------------------------------------ |
| Time    | `2026-03-17T18:45:00.323Z`                                               |
| Action  | `listingCreation/import_existing_variants`                               |
| Doc id  | `2WUzhuF1ntOodX7O2lMz`                                                   |
| Payload | `janCode: 4952270302420`, `handle: furukawa-mini-washi-paper-letter-set` |

Draft before:

```text
proposal 4952270302420
  Default
```

Draft after:

```text
proposal 4952270302420
  Default
  Cat
  Dog
  Sakura
  Hedgehog
  Sakura-Fuji
```

This is the point where the draft picked up the existing Shopify-imported
variants.

### 5. The primary draft's new JAN was renamed from Default to Cat/Flower

| Field  | Value                                          |
| ------ | ---------------------------------------------- |
| Time   | `2026-03-17T18:46:29.846Z`                     |
| Action | `listingCreation/update_variant_value`         |
| Doc id | `0ohBslQ6L8lLd02Vl7Rj`                         |
| Edit   | `4952270302420:Default:00f37d2d -> Cat/Flower` |

Draft changed:

```text
Default -> Cat/Flower
```

### 6. The second draft's JAN was renamed from Default to Strolling Cats

| Field  | Value                                              |
| ------ | -------------------------------------------------- |
| Time   | `2026-03-17T18:46:44.922Z`                         |
| Action | `listingCreation/update_variant_value`             |
| Doc id | `DxYycPGLwOik4CptvBD9`                             |
| Edit   | `4952270287420:Default:ee046202 -> Strolling Cats` |

Draft changed:

```text
Default -> Strolling Cats
```

### 7. The second draft was merged into the shared handle

| Field  | Value                                                          |
| ------ | -------------------------------------------------------------- |
| Time   | `2026-03-17T18:48:31.655Z`                                     |
| Action | `listingCreation/update_proposal_field`                        |
| Doc id | `HJ8jvQiEhMmTPn8i9D8A`                                         |
| Edit   | `4952270287420 handle -> furukawa-mini-washi-paper-letter-set` |

Draft before:

```text
proposal 4952270287420
  Strolling Cats
proposal 4952270302420
  Cat/Flower
  Cat
  Dog
  Sakura
  Hedgehog
  Sakura-Fuji
```

Draft after:

```text
proposal 4952270302420
  Cat/Flower
  Cat
  Dog
  Sakura
  Hedgehog
  Sakura-Fuji
  Strolling Cats
```

This merged the `4952270287420` proposal into the primary proposal for the
shared listing handle.

### 8. Approval replaced the live listing with the 7-pill version

| Field   | Value                              |
| ------- | ---------------------------------- |
| Time    | `2026-03-17T18:53:06.077Z`         |
| Action  | `listingCreation/approve_proposal` |
| Doc id  | `jKMcYVBYD51KqsJNfoIx`             |
| Payload | `janCode: 4952270302420`           |

Live before:

```text
Cat
Dog
Hedgehog
Sakura
Sakura-Fuji
```

Live after:

```text
Cat/Flower
Cat
Dog
Sakura
Hedgehog
Sakura-Fuji
Strolling Cats
```

This is the main structural change: the old 5-pill listing became a 7-pill
listing.

### 9. March 25 image-position edits reordered the live pills

At `2026-03-25T20:49:23Z`, six `update_field` actions changed
`imagePosition` values:

| Doc id                 | Item id in action             | Change                  |
| ---------------------- | ----------------------------- | ----------------------- |
| `ITq3dRneGcydy67Yim7U` | `4952270287321Cat`            | `imagePosition: 2 -> 4` |
| `N7EnXvXcyNlv4LCx3jP8` | `4952270287277Dog`            | `imagePosition: 3 -> 5` |
| `fgfZ0rM1C4U5fZXdb1eE` | `4952270287444Sakura`         | `imagePosition: 4 -> 6` |
| `0fxl28ekFCWr771wUWXL` | `4952270287253Hedgehog`       | `imagePosition: 5 -> 7` |
| `ozlEQoUOhnNrzX4XpYEO` | `4952270287215Sakura-Fuji`    | `imagePosition: 6 -> 8` |
| `LTLEH5RzncT8phEGH5Z2` | `4952270287420Strolling Cats` | `imagePosition: 7 -> 3` |

Net live order before these edits:

```text
Cat/Flower
Cat
Dog
Sakura
Hedgehog
Sakura-Fuji
Strolling Cats
```

Net live order after these edits:

```text
Cat/Flower
Strolling Cats
Cat
Dog
Sakura
Hedgehog
Sakura-Fuji
```

These actions were order changes only. They did not change
`variantOptionsByItemId` labels.

### 10. Sakura-Fuji was moved to position 2

| Field  | Value                                            |
| ------ | ------------------------------------------------ |
| Time   | `2026-03-29T17:53:29.932Z`                       |
| Action | `update_field`                                   |
| Doc id | `UFGCBydg1sRJEFmljANr`                           |
| Edit   | `4952270287215Sakura-Fuji imagePosition: 8 -> 2` |

Live before:

```text
Cat/Flower
Strolling Cats
Cat
Dog
Sakura
Hedgehog
Sakura-Fuji
```

Live after:

```text
Cat/Flower
Sakura-Fuji
Strolling Cats
Cat
Dog
Sakura
Hedgehog
```

This produced the current replayed pill order.

## Non-Visible Subtype Rename Attempts

Three later `update_field` actions look like intended pill-label edits:

| Time                   | Doc id                 | Action         | Raw edit                                             |
| ---------------------- | ---------------------- | -------------- | ---------------------------------------------------- |
| `2026-03-25T20:51:25Z` | `UJ2QB1yYvP8PwYCztxhJ` | `update_field` | `4952270302420Cat/Flower subtype: Cat/Flower -> Cat` |
| `2026-03-25T20:51:40Z` | `UJprbzU7A5hemwOtARqn` | `update_field` | `4952270287321Cat subtype: Cat -> Cat in Mug`        |
| `2026-03-25T20:52:16Z` | `BswPopo3HApO0Guu2BA4` | `update_field` | `4952270287277Dog subtype: Dog -> Shiba`             |

In the current replay, these do **not** change the visible pills.

Reason: the final live listing is keyed by bare item ids such as
`4952270287321`, with labels stored in
`listing.variantOptionsByItemId`. These edits target old subtyped ids such as
`4952270287321Cat`. Since visible live labels are resolved from the listing's
option map, the replayed pills remain:

```text
Cat
Dog
```

not:

```text
Cat in Mug
Shiba
```

The listing body text does mention `Cat in Mug` and `Shiba`, and Shopify sync
logs later used SKUs such as `4952270287321Cat in Mug` and
`4952270287277Shiba`, but the current admin listing detail page resolves the
visible pills from the stored option map:

```json
{
  "4952270287321": "Cat",
  "4952270287277": "Dog"
}
```

## Shopify Sync Observations

The listing was synced several times after the manual edits:

- `2026-03-25T20:54:58Z`: product update, `variantCount: 7`
- `2026-03-27T17:48:56Z`: product update, `variantCount: 7`
- `2026-03-29T17:55:46Z`: product update, `variantCount: 7`

The `shopify_api_log` rows for these syncs show SKU labels that include the
renamed text:

| Sync label in API log     | Example context                            |
| ------------------------- | ------------------------------------------ |
| `4952270302420Cat`        | after `Cat/Flower -> Cat` raw subtype edit |
| `4952270287321Cat in Mug` | after `Cat -> Cat in Mug` raw subtype edit |
| `4952270287277Shiba`      | after `Dog -> Shiba` raw subtype edit      |

This means there is a mismatch between at least two ways the system can derive
variant labels:

1. the listing-detail UI uses `variantOptionsByItemId`
2. some sync/log path used the item subtype/key after the raw subtype edits

This investigation did not change code or data, but this mismatch is worth
separate follow-up if the desired source of truth for listing pill labels is
supposed to be singular.

## Conclusion

The visible pill lineage is replay-stable and consists of:

1. Shopify import created a 5-pill live listing.
2. Listing creation built a 7-pill draft by adding `Cat/Flower` and
   `Strolling Cats`.
3. Approval replaced the live listing with the 7-pill version.
4. Image-position edits reordered the pills.
5. Later raw subtype edits attempted to rename `Cat/Flower -> Cat`,
   `Cat -> Cat in Mug`, and `Dog -> Shiba`, but those edits are not reflected
   by the current listing-detail UI because the UI uses `variantOptionsByItemId`
   for labels.
