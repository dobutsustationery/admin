# Shopify Option Label and Blank Handle Replay Impact

Date: 2026-06-13

## Purpose

This report documents the replay impact of the current open changes that stop Shopify import option labels from being written as inventory subtypes, plus the follow-up blank-handle behavior that preserves a listing by moving it to a generated default handle instead of deleting it.

The motivating bug was `4542804113471`: once Shopify no longer turned `Default Title` into an inventory subtype, a later `update_field(handle -> "")` action applied to the real bare-JAN item. The inventory row stayed correct, but the listings reducer deleted the only local listing for `amifa-berry-cherry-wall-stickers-4542804113471`, so manually restoring the item handle did not relink to a listing object.

## Method

- Dataset: `/tmp/admin2-emulator-dump-4902505451409/firestore-export.json`.
- Actions replayed: `41,771`.
- Baseline code: clean `HEAD` worktree at commit `55a6c84` (`Improve Shopify listing mismatch review`).
- Candidate code: current working tree.
- Reducer replay errors: `0` for both baseline and candidate.
- Full state snapshots were compared after normalizing replay-generated synthetic photo IDs and synthetic photo timestamps.
- A same-code replay of the candidate normalized to an empty diff, so the normalized report excludes replay nondeterminism.

Generated artifacts:

- `/tmp/state-head.json`: clean `HEAD` full replay.
- `/tmp/state-working.json`: candidate replay before the blank-handle default fix.
- `/tmp/state-working-handle-default.json`: candidate replay after the blank-handle default fix.
- `/tmp/open-state-diff-summary.normalized.json`: normalized summary diff between `HEAD` and candidate before the blank-handle default fix.
- `/tmp/open-state-diff-details.normalized.json`: normalized detailed diff between `HEAD` and candidate before the blank-handle default fix.
- `/tmp/handle-default-isolated-impact.json`: isolated diff of only the blank-handle default fix.

## Overall Candidate Impact Versus HEAD

Changed state slices:
- `inventory`
- `keyAudit`
- `listings`
- `photos`

Summary counts:

```json
{
  "slicesChanged": [
    "inventory",
    "keyAudit",
    "listings",
    "photos"
  ],
  "inventory": {
    "idToItem": {
      "added": 143,
      "removed": 143,
      "changed": 1
    },
    "janTotals": {
      "added": 0,
      "removed": 0,
      "changed": 143
    },
    "costLedgerKeys": {
      "added": 143,
      "removed": 143,
      "changed": 1
    },
    "ledgerByJan": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "orderIdToOrder": {
      "added": 0,
      "removed": 0,
      "changed": 54
    },
    "orderRefsByJan": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "stockOrderRegistry": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "idToHistory": {
      "added": 92,
      "removed": 147,
      "changed": 530
    },
    "keyIdentity": {
      "intervalsByKey": {
        "added": 0,
        "removed": 147,
        "changed": 144
      },
      "currentKeyByEntityId": {
        "added": 0,
        "removed": 0,
        "changed": 143
      },
      "entityIdByCurrentKey": {
        "added": 143,
        "removed": 143,
        "changed": 0
      }
    }
  },
  "listings": {
    "handleToListing": {
      "added": 0,
      "removed": 1,
      "changed": 380
    },
    "idToHandle": {
      "added": 143,
      "removed": 143,
      "changed": 0
    }
  },
  "photos": {
    "janCodeToPhotos": {
      "added": 6,
      "removed": 7,
      "changed": 1
    },
    "driveToShopify": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "shopifyToDrive": {
      "added": 0,
      "removed": 0,
      "changed": 0
    }
  },
  "keyAudit": {
    "ghostMap": {
      "added": 0,
      "removed": 4,
      "changed": 0
    },
    "canonicalCollisions": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "canonicalIncomingIndex": {
      "added": 0,
      "removed": 0,
      "changed": 0
    },
    "ghostAccessEvents": {
      "added": 0,
      "removed": 0,
      "changed": 0
    }
  }
}
```

### Inventory

- `idToItem`: `143` keys added, `143` keys removed, `1` common key changed.
- The `143` add/remove pairs are key moves from Shopify-derived subtype labels to bare JANs.
- JAN aggregate qty/shipped/on-hand: no numeric changes. The `143` JAN-total diffs are key-list changes only.
- Cost ledger keys: `143` added, `143` removed, `1` common key changed.
- Cost ledger by JAN: `0` changes.
- Order references by JAN: `0` changes.
- Stock order registry: `0` changes.

Examples of key moves:
- `4520491375105Bird` -> `4520491375105`
- `4520491375112Otter` -> `4520491375112`
- `4542804090369Masterpiece 2` -> `4542804090369`
- `4542804119848Masterpiece 1` -> `4542804119848`
- `4542804154597Cats` -> `4542804154597`
- `4542804154610Dogs` -> `4542804154610`
- `4560103149144Bear` -> `4560103149144`
- `4560103149328Fox` -> `4560103149328`
- `4560103149366Monkey` -> `4560103149366`
- `4570198770093Collection` -> `4570198770093`
- `4582608265501Gold` -> `4582608265501`
- `4582608265532Pink` -> `4582608265532`
- `4901470099159Grid` -> `4901470099159`
- `4901470099173Lined` -> `4901470099173`
- `4901470099272Blank` -> `4901470099272`
- `4901681382316Standard` -> `4901681382316`
- `4901681382330Dark` -> `4901681382330`
- `4901681382347Pastel` -> `4901681382347`
- `4901681413713White` -> `4901681413713`
- `4901681413737Rose` -> `4901681413737`

The only common inventory row changed in place is:

```json
{
  "key": "4542804113471",
  "fields": [
    {
      "field": "handle",
      "before": "amifa-berry-cherry-wall-stickers-4542804113471",
      "after": ""
    },
    {
      "field": "subtype",
      "before": "Default",
      "after": ""
    }
  ]
}
```

For `4542804113471`, accounting values do not change: qty, shipped, cost, weight, cost ledger, and order references are unchanged. The item changes from subtype `Default` and handle `amifa-berry-cherry-wall-stickers-4542804113471` to blank subtype and blank handle because the action log contains an explicit `update_field` that clears the handle.

### Orders And Cost Ledger

- `orderIdToOrder`: `54` orders changed at the raw key level.
- Order reference totals grouped by JAN: `0` changes.
- Cost ledger grouped by JAN: `0` changes.
- The common cost-ledger change is only the sale entry ID text for `4542804113471`, where the embedded item key changes from `4542804113471red` to `4542804113471`. Quantities and values are unchanged.

### Listings

- `handleToListing`: `1` removed, `380` changed before the blank-handle default fix.
- Removed listing before the blank-handle default fix:
  - `amifa-berry-cherry-wall-stickers-4542804113471`
- `idToHandle`: `143` added, `143` removed, matching the inventory key moves.
- Most changed listings have `variantOptionsByItemId` updates. These preserve Shopify option labels as listing metadata instead of inventory subtypes.
- Two changed listings also have image array differences after normalization.

### Photos

- `janCodeToPhotos`: `6` added, `7` removed, `1` changed after normalization.
- These are photo group key moves caused by inventory/listing option label key changes.

Added photo keys:
- `4901681382316`
- `4952270287215`
- `4952270287277:Dog`
- `4952270287321:Cat`
- `4952270302420:Cat/Flower`
- `4977564613341`

Removed photo keys:
- `4901681382316:Standard`
- `4902778028179:Black`
- `4952270287215:Sakura-Fuji`
- `4952270287277:Shiba`
- `4952270287321:Cat in Mug`
- `4952270302420:Cat`
- `4977564613341:Blue`

Changed photo keys:
- `4902778028179`

### Key Audit

- `ghostMap`: `4` entries removed.
- No changes to canonical collisions, canonical incoming index, or ghost access events.

Removed ghost-map keys:
- `4542804113471red`
- `4952270287277Dog`
- `4952270287321Cat`
- `4952270302420Cat/Flower`

## Blank Handle Default Fix

The follow-up reducer change modifies `listings-slice.applyHandleUpdate`: when an item handle is changed to blank and the old handle is no longer used by any item, the listing is not deleted. Instead, if possible, it is moved to the generated default handle `generateHandle(listing.title, JAN)` and `idToHandle[itemId]` is set to that generated handle.

Isolated impact of this blank-handle default fix, compared with the candidate state before this fix:

```json
{
  "slices": [
    "listings"
  ],
  "handleToListing": {
    "added": [
      "amifa-berry-cherry-wall-stickers-55-4542804113471",
      "amifaspecial-a5-two-zipper-net-stationery-case-4542804155181",
      "amifaspecial-b6-two-zipper-net-stationery-case-4542804155198",
      "kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-4969757171813"
    ],
    "removed": [],
    "changed": []
  },
  "idToHandle": {
    "added": [
      "4542804050851dog",
      "4542804113471",
      "4542804123555Transparent",
      "4542804147667Blue",
      "4542804147667Cream",
      "4542804155174Blue",
      "4542804155181Blue",
      "4542804155198Blue"
    ],
    "removed": [],
    "changed": []
  },
  "inventory": {
    "added": [],
    "removed": [],
    "changed": []
  },
  "costLedger": {
    "added": [],
    "removed": [],
    "changed": []
  },
  "orders": {
    "added": [],
    "removed": [],
    "changed": []
  },
  "photos": {
    "added": [],
    "removed": [],
    "changed": []
  }
}
```

Important properties of the isolated fix:

- Changed slice: `listings` only.
- Inventory rows: `0` changes.
- Cost ledger: `0` changes.
- Orders: `0` changes.
- Photos: `0` changes.

Listings preserved or newly reachable by the blank-handle default fix:
- `amifa-berry-cherry-wall-stickers-55-4542804113471`
- `amifaspecial-a5-two-zipper-net-stationery-case-4542804155181`
- `amifaspecial-b6-two-zipper-net-stationery-case-4542804155198`
- `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-4969757171813`

Item-to-listing mappings restored by the blank-handle default fix:
- `4542804050851dog`
- `4542804113471`
- `4542804123555Transparent`
- `4542804147667Blue`
- `4542804147667Cream`
- `4542804155174Blue`
- `4542804155181Blue`
- `4542804155198Blue`

For `4542804113471`, the listing moves as follows:

- Old listing handle from baseline/current Shopify data: `amifa-berry-cherry-wall-stickers-4542804113471`.
- Generated default handle after handle clear: `amifa-berry-cherry-wall-stickers-55-4542804113471`.
- `listings.idToHandle["4542804113471"]` points to `amifa-berry-cherry-wall-stickers-55-4542804113471`.
- The inventory item still has `handle: ""`, because the broadcast action explicitly cleared the inventory handle.

This makes manual relinking possible because the listing object still exists. It does, however, rekey the local listing to the generated default handle rather than preserving the prior Shopify handle. That is the expected consequence of treating blank handle as "fall back to default handle".

## Risk Assessment

- Accounting risk is low in this replay: JAN-level cost ledger, order references, stock order registry, qty, shipped, and on-hand values do not change numerically.
- Listing/UI risk is material: local listing handles and variant-option metadata change. This is intended for Shopify option labels, but the blank-handle case needed the default-handle preservation fix to avoid deleting listings.
- Photo grouping risk is moderate: several photo group keys move from subtype-labeled keys to bare/default-option keys. The actual photo payloads are preserved, but UI grouping can move.
- Existing blank-handle actions are now interpreted as "use generated default listing handle" when a listing would otherwise be orphaned. This prevents deletion but can create a different local handle than the old Shopify handle if the title slug has changed.

## Verification

Commands run after the blank-handle default fix:

```sh
npm test -- --run tests/unit/listing-handle-update.test.ts tests/unit/listing-handle-sync.test.ts tests/unit/listing-title-sync.test.ts tests/unit/shopify-image-conflict.test.ts tests/unit/order-exceptions.test.ts
npm run check
```

Both passed.