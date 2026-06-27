# Love & Fur Sticky Notes Listing Mismatch -- Jun 27 2026

## Scope

This investigation traces the listing mismatch for the Love & Fur sticky
notes product:

- JAN: `4969757171813`
- Variants: `Pomeranian`, `Poodle`, `Schnauzer`, `Shiba`
- Shopify handle currently in the catalog mirror:
  `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`

Source data:

- Broadcast replay backup:
  `../production-backup-jun-26-trace-4542804151626/firestore-export.json`
- Branch blast-radius snapshots:
  `.blastradius/runs/no-inventory-listing-creation-jun27-v3/`

No production data was modified during this investigation.

## Summary

The mismatch is real historical data, not only a current UI display issue.

The listing started as one intended four-variant listing, but the proposal's
handle was manually set to a free-form, non-Shopify-safe value:

`Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)`

That value was then synced to Shopify multiple times. Shopify did not preserve
that exact handle; it slugged and de-duplicated it, yielding a sequence of
Shopify handles:

- `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75`
- `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-76`
- `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`

The active Shopify product that survives in catalog sync is product
`15830616244606` at handle
`kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77`.

Admin replay also has a separate local listing path under the generated
JAN-suffixed handle:

`kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-4969757171813`

The old listing reducer hid this mismatch by allowing handle edits or inventory
updates to synthesize local listing rows. The stricter reducer correctly stops
doing that, which exposes the inconsistency: item rows now point to the Shopify
handle `...-77`, but local `listings.idToHandle` does not link those items to a
local listing row at `...-77`.

## Timeline

| Time UTC | Broadcast action | Effect |
|---|---|---|
| 2026-03-18 16:42 | `listingCreation/add_proposals` | Created one intended four-variant proposal for JAN `4969757171813`. |
| 2026-03-18 16:44 | `listingCreation/update_proposal_field` | Operator set `field:"handle"` to the free-form value `Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)`. |
| 2026-03-18 16:46 | `listingCreation/update_proposal_field` | Title changed to `Dobutsu Love & Fur Dog Mini Sticky Notes (75)`. |
| 2026-03-18 16:52 | `listingCreation/approve_proposal` | Approved the proposal, creating four inventory variants. In current replay this local listing is keyed as `...75-4969757171813`. |
| 2026-03-18 16:54 | `shopify_api_log product_update` | Shopify response product `15830609428862`, handle `...sticky-notes-75`. |
| 2026-03-18 16:55 | `shopify_api_log product_update` | Shopify response product `15830612836734`, handle `...sticky-notes-76`. |
| 2026-03-18 16:56 | `shopify_api_log product_update` | Shopify response product `15830616244606`, handle `...sticky-notes-77`. |
| 2026-03-18 20:51 | `update_field(handle -> "")` | Operator cleared the listing handle on the variants. |
| 2026-03-18 20:52 | `update_field(handle -> ...75-4969757171813)` | Operator set the variants to the generated JAN-suffixed admin handle. |
| 2026-03-30 onward | `shopifyCatalog/apply_sync_chunk` | Catalog sync consistently reports product `15830616244606` at handle `...sticky-notes-77`. |
| 2026-06-25 18:40 | `update_field(handle -> ...77)` | Operator moved all four inventory variants from `...75-4969757171813` to `...77`. |
| 2026-06-25 19:17 | `shopify_api_log product_update` | Sync updated Shopify product `15830616244606` at handle `...77`. |
| 2026-06-25 19:18 onward | `shopifyCatalog/apply_sync_chunk` | Catalog mirror confirms handle `...77`, title `Kyowa Love & Fur Dog Mini Sticky Notes (75)`, active product. |

## Proposal Payload

The original proposal was structurally correct as a four-variant listing:

| Variant | Photo group |
|---|---|
| `Pomeranian` | `4969757171813:Pomeranian` |
| `Poodle` | `4969757171813:Poodle` |
| `Schnauzer` | `4969757171813:Schnauzer` |
| `Shiba` | `4969757171813:Shiba` |

The bad field was the handle. The proposal used a human-readable title-like
string as the handle, rather than a Shopify slug.

## Shopify Evidence

The product update logs show three distinct Shopify product responses for the
same free-form handle sync sequence:

| Time UTC | Product ID | Shopify response handle |
|---|---:|---|
| 2026-03-18 16:54 | `15830609428862` | `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75` |
| 2026-03-18 16:55 | `15830612836734` | `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-76` |
| 2026-03-18 16:56 | `15830616244606` | `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-77` |

Later catalog syncs only report the `...-77` product for this JAN:

| Catalog sync date | Handle | Product ID | Variant SKUs |
|---|---|---:|---|
| 2026-03-30 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-05-03 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-05-18 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-06-01 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-06-20 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-06-25 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |
| 2026-06-26 | `...sticky-notes-77` | `15830616244606` | all four `4969757171813...` SKUs |

I did not find catalog mirror evidence that `...-75` or `...-76` survive as
active catalog products in the replayed backup. They appear in API responses
during the initial bad-handle sync sequence.

## Materialized State Under Current Branch

After replaying the Jun 26 backup through the current stricter reducer:

Inventory rows:

| Item key | `item.handle` | Qty | Shipped |
|---|---|---:|---:|
| `4969757171813Pomeranian` | `...sticky-notes-77` | 12 | 1 |
| `4969757171813Poodle` | `...sticky-notes-77` | 12 | 2 |
| `4969757171813Schnauzer` | `...sticky-notes-77` | 12 | 4 |
| `4969757171813Shiba` | `...sticky-notes-77` | 12 | 1 |

Local listing state:

- `listings.handleToListing["...sticky-notes-77"]`: absent
- `listings.idToHandle[4969757171813...]`: absent for all four variants
- `listings.handleToListing["...75-4969757171813"]`: present

Shopify catalog mirror:

- `shopifyCatalog.handleToListing["...sticky-notes-77"]`: present
- Product ID: `15830616244606`
- Title: `Kyowa Love & Fur Dog Mini Sticky Notes (75)`
- Variants: all four `4969757171813...` SKUs
- Latest observed catalog `updatedAtIso`: `2026-06-26T07:19:30Z`

## Why This Became Visible Now

The branch intentionally enforces this rule:

> Inventory updates and handle edits must not create or delete listing rows.

That is the right direction. It prevents incidental inventory metadata changes
from silently manufacturing listing state.

However, this Love & Fur case relied on exactly that old behavior. The local
admin listing row for `...sticky-notes-77` was not created by an explicit
listing action in the historical log. It appeared because the old reducer was
willing to synthesize listing rows when item handles changed.

Once that behavior is removed, replay exposes the true mismatch:

- Shopify and item metadata say `...sticky-notes-77`.
- Local listing approval history says `...75-4969757171813`.
- No explicit action reconciles the two local listing identities.

## Interpretation

The operator intent appears to have been:

1. Create one four-variant Love & Fur sticky notes listing.
2. Publish/sync it to Shopify.
3. Later align admin item handles with the Shopify product handle that actually
   exists, `...sticky-notes-77`.

The system did not have a clean explicit action for "link/re-key this local
listing to the Shopify handle." Instead, the old reducer produced that outcome
as a side effect of handle edits.

## Recommended Fix Direction

Do not restore listing creation from `update_item`, `bulk_import_items`, or
`update_field(handle)`.

This case needs an explicit reconciliation path. Reasonable options:

1. Add an operator action that re-keys or links an existing local listing to a
   known Shopify catalog handle.
2. Make Shopify import/catalog reconciliation capable of explicitly creating or
   linking local listing rows from known Shopify products, rather than relying
   on inventory handle side effects.
3. Add a targeted data remediation for this listing once the intended general
   action exists.

The important constraint is that the action should be explicit and auditable.
The reducer should not infer listing creation from an item handle edit.
