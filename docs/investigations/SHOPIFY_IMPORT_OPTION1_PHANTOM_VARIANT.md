# Phantom "red" variant on JAN 4542804113471 — Shopify-import MATCH path

## Scope

JAN `4542804113471` shows a variant in the admin UI ("red") that
shouldn't exist. This investigation walks the replay of the Apr 25
production backup (`../production-backup-apr-25/firestore-export.json`)
to find where the variant came from, what the resulting state actually
looks like, and which code path produced the divergence.

This is read-only analysis. No code change is proposed in this doc.

## TL;DR

The inventory row for this JAN is **malformed**: the `idToItem` map
keys it under the bare JAN, but the row's `subtype` field reads
`"red"`. The two should agree (either both bare or both subtyped).
The disagreement was introduced by the Shopify CSV import's MATCH
branch when it lifted the Shopify Option1 value onto the existing
inventory row without re-keying.

Two contributing factors:

1. **Shopify side**: the product `amifa-berry-cherry-wall-stickers-4542804113471`
   is configured with `Option1 Name/Value` set to something / `"Red"`,
   so Shopify reports it as a one-variant variant family rather than
   a "Default Title" single-variant product.
2. **Admin side**: `computeShopifyImportBatch` (`src/lib/shopify-import-slice.ts:413`)
   copies `option1Value` into the existing row's `subtype` field
   without consulting `canonicalizeInventoryItemKey` or re-keying
   `idToItem`. Same family of "key and subtype must agree" invariant
   that audit row 15 ran afoul of.

## Final state

After replaying all 24,799 broadcast actions:

```json
"4542804113471": {
  "janCode": "4542804113471",
  "subtype": "red",
  "description": "Amifa Berry & Cherry Wall Stickers (55)",
  "qty": 39,
  "shipped": 0
}
```

The map key is `"4542804113471"` (bare JAN). The `subtype` field is
`"red"`. The canonical form for a row with subtype `"red"` would be
`"4542804113471red"`, but no such key exists in `idToItem`.

UI rendering then walks `idToItem` and shows a JAN that has a "red"
variant. There is no second row to flip the JAN into a "no subtype"
state, so the operator sees a single phantom variant where in reality
this product has no real variant family.

## Trace

Only six broadcast actions reference this JAN. Replaying them all
through `rootReducer` and snapshotting `idToItem[startsWith("4542804113471")]`
at each step, only one of them is responsible for the divergence:

| When (UTC) | Action | Effect on idToItem |
|---|---|---|
| 2024-10-09 07:38:00 | `update_item` | Create row, `subtype=""`, qty=40 |
| 2025-05-02 17:36:14 | `archive_inventory` "Japan Festival April 2025" | qty 40 → 0 |
| 2025-05-04 08:34:07 | `update_item` | qty 0 → 39, `subtype=""` (unchanged) |
| **2026-03-02 20:42:01** | **`shopifyImport/import_batch` (filter=MATCH)** | **`subtype` "" → "red"**, description rewritten |
| 2026-03-30 17:15:44 | `shopifyCatalog/apply_sync_chunk` | No effect on `idToItem` (writes only to `shopifyCatalog.handleToListing`) |
| 2026-03-30 17:30:06 | `shopifyCatalog/apply_sync_chunk` | Same |

State change at the responsible action:

```
before: {"4542804113471":
  {"jan":"4542804113471","sub":"",
   "desc":"Stickers Wall Red Fruit","qty":39,"shipped":0}}

after:  {"4542804113471":
  {"jan":"4542804113471","sub":"red",
   "desc":"Amifa Berry & Cherry Wall Stickers (55)","qty":39,"shipped":0}}
```

## The Shopify-side trigger

The Shopify catalog chunks reference this JAN with a single variant
that carries an Option1 value of "Red":

```json
{ "id": "56535655940478",
  "sku": "4542804113471",
  "subtype": "Red",
  "janCode": "4542804113471",
  "weight": 31.2,
  "inventoryQuantity": 37,
  "image": "" }
```

There is one and only one variant on this product. Shopify always
emits at least one variant; a true single-variant product would
carry Option1 Name "Title" / Value "Default Title". Some past edit
left this product with a real-looking option value `"Red"` instead,
so on the wire it looks indistinguishable from a real variant family.

## The reducer mechanism

The mutation happens in `computeShopifyImportBatch`,
`src/lib/shopify-import-slice.ts:413`, in the `filter === "MATCH"`
branch:

```ts
const newItem = {
  ...baseItem,
  price: item.price,
  weight: item.weight,
  ...(useHandles ? { handle: item.handle } : {}),
  qty: ignoreQty ? 0 : delta,
  ...(useDesc ? { description: item.description } : {}),
  ...(useImg
    ? { image: item.image, listingImage: sanitizedListingImage }
    : {}),
  bodyHtml: item.bodyHtml,
  productCategory: item.productCategory,
  subtype: item.option1Value || baseItem.subtype, // Update Subtype
};

updates.push({
  type: "update",
  id: key,
  item: newItem,
});
```

`key` here is the *existing* `idToItem` key — in this case the bare
JAN, since that's what the row was keyed under. `item.option1Value`
is `"Red"` from the Shopify CSV row. The resulting `update`
overwrites the row's `subtype` field in place, while leaving the map
key untouched.

`computeShopifyImportBatch` does not consult
`canonicalizeInventoryItemKey`, does not synthesize a `rename_subtype`
or `retype_item` action, and does not delete-and-re-insert under a
new key. The row therefore ends up with a `subtype` field that
disagrees with its position in `idToItem`.

The casing change (`"Red"` → `"red"`) happens downstream of this
write; either the dispatched `update_item` action or one of the
update-applying handlers normalizes subtype to lowercase. The case
is incidental — the structural defect is the key/subtype disagreement.

## Why this is the same family as audit row 15

`docs/investigations/GHOST_MISSING_15_AUDIT.md` row 15 documents a
related invariant break: an `update_field({id, field:"subtype", ...})`
that re-keyed an inventory row, leaving a follow-up `update_field`
targeting the old (now-ghost) key.

The general rule is: **the `idToItem` map key must equal
`makeInventoryItemKey(row.janCode, row.subtype)` for every row.**
Any code path that changes `janCode` or `subtype` without re-keying
breaks the invariant. Today there are at least two such paths:

- `computeShopifyImportBatch` MATCH branch (this investigation).
- `onConfirmAddVariant` (already addressed in PR #120 by reordering
  dispatches; the underlying reducer guarantee is still that subtype
  updates re-key, but the dispatcher had been emitting follow-on
  actions against the pre-rename key).

Anywhere the invariant breaks, the UI ends up showing a "variant"
that has no real semantic meaning — it's just a string riding along
on a map key that doesn't match.

## Remediation paths

None of these is being applied here; this doc just records the
options. The user-facing problem is purely data on JAN
`4542804113471` plus the latent reducer behavior.

**Single-record data fixes:**

1. **In Shopify Admin**: open this product, remove the Option1 name
   and value (or set them to the Shopify defaults — Option1 Name
   "Title", Option1 Value "Default Title"). Re-run the Shopify
   import. The MATCH branch then writes `subtype = "" || baseItem.subtype`,
   which falls through to the existing `""`, and the phantom variant
   goes away on the next sync.
2. **In the admin app**: issue an `update_field({id:"4542804113471",
   field:"subtype", from:"red", to:""})` to clear the subtype field
   in place. This works against the current data but is fragile —
   the next Shopify MATCH import will re-lift Option1="Red" back onto
   the row.

**Structural code fixes (out of scope here):**

- `computeShopifyImportBatch` MATCH branch should canonicalize on
  write: when `item.option1Value` differs from `baseItem.subtype`,
  emit a re-key (effectively, treat the subtype field as identity,
  not data). This keeps `idToItem` self-consistent regardless of
  what Shopify ships.
- Or: when matching by JAN, **don't** copy Option1 onto a row whose
  current canonical key is `JAN-only` (bare JAN). Either skip the
  subtype write, or refuse the match and route to NEW.
- Or: add a reducer-level invariant check that asserts
  `idToItem[k].janCode + idToItem[k].subtype === k` and jails any
  action that would break it. (Same shape as the existing
  `canonicalCollisions` instrumentation in `keyAudit`.)

The minimal "this product specifically" fix is #1 — clean it up in
Shopify and let the next import flush it through. The structural
fix is whichever of the three the team prefers, on its own PR.

## Reproduction

```bash
# Quick replay + final-snapshot for this JAN:
cat <<'EOF' > /tmp/trace-113471.ts
import { readFileSync } from "fs";
import { rootReducer } from "/Users/anicolao/projects/antigravity/admin2/src/lib/root-reducer";
const BACKUP = "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";
const JAN = "4542804113471";
function tsKey(a:any){const ts=a?.timestamp;return ts?._seconds?ts._seconds*1e9+(+ts._nanoseconds||0):ts?.seconds?ts.seconds*1e9+(+ts.nanoseconds||0):0}
const docs = JSON.parse(readFileSync(BACKUP,"utf-8")).collections.broadcast.documents;
const actions = docs.map((d:any)=>({id:d.id,...d.data})).sort((a:any,b:any)=>tsKey(a)-tsKey(b));
let s:any = rootReducer(undefined,{type:"@@INIT"});
for (const a of actions) { try { s = rootReducer(s,a as any,()=>{}); } catch{} }
const items = s.inventory.idToItem;
for (const k of Object.keys(items)) if (k.startsWith(JAN)) console.log(k, items[k]);
EOF
bun run /tmp/trace-113471.ts
```

Expected output:

```
4542804113471 { janCode: '4542804113471', subtype: 'red', description: 'Amifa Berry & Cherry Wall Stickers (55)', qty: 39, shipped: 0, ... }
```

Note the key is the bare JAN while `subtype === "red"`.
