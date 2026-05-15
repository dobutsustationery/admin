# `console.error` census — Apr 25 backup replay

## Scope

Replays all 24,799 broadcast actions from the Apr 25 production backup
(`../production-backup-apr-25/firestore-export.json`) through
`rootReducer` with `console.error` monkeypatched to tally every message
by normalized category, the triggering action type, counts, and a
representative example.

Goal: enumerate every distinct error the reducer pipeline emits during
a faithful replay and recommend what to do about each category.

Read-only analysis. No code change in this doc.

Methodology / reproducer: `scripts/replay-console-error-census.ts`.

## Headline result

```
total console.error calls : 93
distinct semantic categories : 1
```

Every single `console.error` during a full replay is the **same
message**:

```
[InventoryValidation] Item update ID mismatch!
  Passed ID: "<JAN>",
  Expected Canonical ID: "<JAN><Subtype>"
  (JAN: "<JAN>", Subtype: "<Subtype>")
```

The census script reports "64 distinct categories" but that is an
artifact of the normalizer keeping the human-readable subtype text
("Flake Stickers", "Deco Seals", "Pink", "Masterpiece 1", …). Collapse
the subtype and it is exactly one category, with **100% of occurrences
triggered by `shopifyImport/import_batch`**.

No other reducer in the pipeline emits `console.error` on this backup:
no `[InventoryDebug]` state-shape errors, no replay exceptions, no
merge-conflict errors, nothing from the order-import, listings,
photos, catalog-sync, or key-audit slices.

## The one category

### What it is

Emitted at `src/lib/inventory.ts:651`, inside `applyInventoryUpdate`:

```ts
if (item.janCode) {
  const canonicalId = makeInventoryItemKey(item.janCode, item.subtype || "");
  if (id !== canonicalId &&
      canonicalizeInventoryItemKey(id) === canonicalId) {
    id = canonicalId;            // auto-correct path (does NOT fire here)
  }
  if (id !== canonicalId) {
    console.error(
      `[InventoryValidation] Item update ID mismatch! Passed ID: "${id}", `
      + `Expected Canonical ID: "${canonicalId}" `
      + `(JAN: "${item.janCode}", Subtype: "${item.subtype || ""}")`,
    );
  }
}
```

The validator checks that the inventory map key (`id`) equals
`makeInventoryItemKey(janCode, subtype)`. There is an auto-correct
branch, but it only fires when `canonicalizeInventoryItemKey(id)`
already equals the canonical id — i.e. when the id is structurally a
canonical key that just needs whitespace/format normalization. It
cannot fire here because the passed `id` is a **bare JAN** with no
subtype component, while the item carries a non-empty `subtype`. There
is no way to recover the subtype from the bare JAN, so auto-correct is
skipped, the error is logged, and **the update proceeds anyway** —
writing the row under the bare-JAN key (`state.idToItem[id]` at
`inventory.ts:692` with the un-corrected `id`).

### Why it fires — root cause

`computeShopifyImportBatch` (`src/lib/shopify-import-slice.ts`) builds
its update list with a bare-JAN id while moving the Shopify Option1
value into the item's `subtype` field. Both branches do this:

- **MATCH branch** (`shopify-import-slice.ts:~413`):
  ```ts
  const newItem = { ...baseItem, …, subtype: item.option1Value || baseItem.subtype };
  updates.push({ type: "update", id: key, item: newItem });
  ```
  `key` is the existing inventory map key, which for these products is
  the bare JAN.

- **NEW branch** (`shopify-import-slice.ts:482-495`):
  ```ts
  const itemWithSubtype = { ...item, subtype: item.option1Value || "" };
  updates.push({ type: "new", id: item.janCode, item: itemWithSubtype });
  ```
  `id` is explicitly `item.janCode` (bare JAN) while `subtype` is set
  from the Shopify Option1 value.

So whenever a Shopify product carries an Option1 value (i.e. has a
real variant subtype — which is most catalogued products), the import
emits an update whose id (bare JAN) disagrees with its
`janCode + subtype`. `applyInventoryUpdate` flags exactly that
disagreement.

This is the **same root cause** documented in
`docs/investigations/SHOPIFY_IMPORT_OPTION1_PHANTOM_VARIANT.md`: the
Shopify import lifts `option1Value` into `subtype` without re-keying
`idToItem`. The `console.error` census is the diagnostic shadow of
that bug — every "phantom variant" write announces itself here first.

### Severity

- **The log itself is benign** — it does not throw, does not abort the
  replay, and the import still applies. So it is not an availability
  problem.
- **What it indicates is not benign** — each line marks an inventory
  row being written under a non-canonical key (bare JAN with a
  subtype field that disagrees). That is the malformed-row condition
  analyzed in the phantom-variant investigation: the UI then renders
  a "variant" whose key doesn't match its subtype, and Shopify
  round-trips desync.
- **Volume**: 93 occurrences across a ~7-month action history; ~all
  concentrated in `shopifyImport/import_batch` runs. Low frequency,
  but each one is a real data-shape defect, not noise.

### Recommendation

This category does not warrant its own fix — it should be resolved by
fixing the upstream import, which is already scoped in
`SHOPIFY_IMPORT_OPTION1_PHANTOM_VARIANT.md`. Concretely, ranked:

1. **Fix the import to canonicalize on write** (primary). In
   `computeShopifyImportBatch`, when `item.option1Value` (→ subtype)
   is non-empty, push the update under
   `makeInventoryItemKey(item.janCode, subtype)` instead of the bare
   JAN — and re-key any existing bare-JAN row. This eliminates the
   root cause; the `console.error` then naturally goes silent because
   the ids will be canonical. Mirrors the fix shape already shipped
   for proposal handles (`canonicalizeHandle` at the reducer
   boundary) and the `retype_item` shipped-counter decoupling.

2. **Strengthen `applyInventoryUpdate`'s auto-correct** (defense in
   depth). Today auto-correct only handles the
   "structurally-canonical-but-unnormalized" case. It could also
   handle the "bare JAN + explicit subtype in payload" case: if
   `id === item.janCode` and `item.subtype` is non-empty and
   `state.idToItem[canonicalId]` is absent, treat it as the canonical
   write (optionally migrating an existing bare-JAN row). This makes
   the reducer robust regardless of which caller is sloppy — same
   "canonicalize on write, not on read" principle as the other
   investigations. Pair with a one-time data migration for rows
   already written under bare-JAN keys.

3. **Promote the log to a jailed action** (observability). If the
   team wants this to be loud rather than silent-with-a-log, route
   the mismatch through the existing `keyAudit` instrumentation
   (`ghostMap` / `canonicalCollisions`) or the `jailed` collection,
   so it surfaces on the audit page instead of only in the console.
   This is orthogonal to the fix and only worth doing if #1 is
   deferred.

4. **Do nothing to the log specifically.** It is a correct,
   well-formed diagnostic. Once #1 lands it stops firing on its own.
   There is no value in suppressing or downgrading the message while
   the underlying bare-JAN writes still happen — that would hide the
   phantom-variant defect.

The recommended path is **#1**, tracked under the phantom-variant
investigation, with **#2** as a cheap reducer-level safety net that
also retro-protects against any other caller passing a bare JAN with
a subtype. No action is needed on categories 2..N because there are
none.

## What the absence of other errors tells us

Equally important: a faithful 24,799-action replay produces **zero**
errors from any slice other than this one validator. The
`[InventoryDebug]` guard rails (missing state, missing idToHistory,
missing idToItem), the merge-conflict paths, the order-import and
catalog-sync reducers, and the key-audit pipeline all run clean on
real production data. The reducer pipeline is, on this evidence,
healthy except for the single known import-canonicalization defect.

(Note: `console.warn` is a separate, much noisier channel —
`Skipping update_field for missing item`, `Skipping package_item for
missing item`, `Variant ID collision`, etc. Those are catalogued
under `GHOST_MISSING_15_AUDIT.md` and the phantom-variant doc and are
out of scope here, which is strictly `console.error`.)

## Reproduction

```bash
bun run scripts/replay-console-error-census.ts 2>&1 \
  | sed -n '/===== console.error census =====/,$p'
```

The script monkeypatches `console.error` before importing
`rootReducer` (so module-load logging is captured too), replays the
backup, normalizes each message (masking JANs/URLs/hex/ids/digits),
and prints per-category counts, an example, and the triggering action
type distribution.
