# Replay performance — Apr 25 backup profile

## Question

Full replay of the production action log feels slow, and subjectively
the actions past ~22,000 seem to take a long time. Profile it and
explain.

Methodology / reproducer: `scripts/profile-replay.ts` (times every
action through `rootReducer`, buckets wall-time per 1000 actions,
samples state size per bucket, ranks cost by action type and the
slowest individual actions). Backup:
`../production-backup-apr-25/firestore-export.json` (24,799 actions).

## Headline numbers

```
Total: 81.8 s   24,799 actions   mean 3.30 ms/action   (~303 actions/s)
```

The cost is **not** spread across the tail and is **not** caused by
state growing. It is one action type, densely batched.

### Wall time per 1000-action bucket

```
   0–21000   ~0.2–1.1 ms/action   (each 1k bucket: 0.2s–1.1s)
21000–22000  19.3 s   (19.3 ms/action)   ← spike begins
22000–23000  44.9 s   (44.9 ms/action)   ← peak
23000–24799  ~0.9–1.9 ms/action  (back to normal)
```

Buckets 21k–23k alone are **~64 s of the 81.8 s total (78%)**. The
user's "22,000+ is slow" observation is real — but it is an
*index-range* artifact, not a position/size effect (see below).

### Cost by action type (top of list)

```
type                              count   totalMs   avgMs   maxMs
photos/shopify_cdn_uploaded         703     60467   86.013  108.5
photos/complete_upload             3399      5010    1.474    3.8
listingCreation/approve_proposal    280      4268   15.244   54.0
photos/complete_edit               2776      3153    1.136    4.9
update_item                        1225      1071    0.875    7.4
shopifyImport/import_batch            1       211  210.894  210.9
... (everything else < 2 ms/action)
```

**`photos/shopify_cdn_uploaded` is 60.5 s — 74% of the entire
replay** — at ~86 ms/action across 703 actions. The 30 slowest
individual actions are *all* `photos/shopify_cdn_uploaded`, every one
in index range **21,584–23,015** — exactly the 21k–23k spike. This is
a bulk Shopify-CDN→Drive image-migration episode that happened in that
window; the actions are clustered by index purely because they were
broadcast together.

The lone `shopifyImport/import_batch` (211 ms at index 3809) explains
the small 3k–4k bump and is a harmless one-off.

### State size is flat — it is not an O(n)-over-growing-state problem

Per-bucket state sampling:

```
atIndex idToItem orders ordLines ghostMap handleToListing
   4000     1102     51     1051       14   524
  12000     1180     51     1051       23   606
  22000     1312     51     1051       28   779
  24799     1316     51     1051       37   779
```

From bucket ~4000 onward `idToItem`, `orders`, `orderLines` are
essentially constant. The slowdown is therefore **not** a quadratic
"scan grows as state grows" effect. It is a *fixed* heavy per-action
cost that simply gets paid 703 times in a row during the migration
burst.

## Root cause

`rootReducer`'s `photos/shopify_cdn_uploaded` handler
(`src/lib/root-reducer.ts:544`) does, **on every action**:

1. `const nextIdToItem = { ...inventoryState.idToItem }` — full clone
   of ~1,316 inventory entries.
2. `Object.entries(nextIdToItem).forEach(...)` — iterate **all**
   ~1,316 items, calling `canonicalizeShopifyCdnUrl(item.image)` for
   each. `canonicalizeShopifyCdnUrl` runs `new URL(value)` plus regex
   work — an expensive parse — per item.
3. `const nextHandleToListing = { ...listingsState.handleToListing }`
   — full clone of ~779 listings.
4. `Object.entries(nextHandleToListing).forEach(...)` — iterate **all**
   ~779 listings and, for each, iterate its `images[]`, calling
   `canonicalizeShopifyCdnUrl(img.url)` (another `new URL()`) per
   image.

The set of URLs that can actually match is tiny — `sourceCandidates`
is ≤ 4 URLs derived from the action payload. Yet every action
re-parses and re-canonicalizes the image URL of *every* inventory
item and *every* listing image, and clones both maps wholesale, even
though in the overwhelmingly common case nothing matches.

Quantitatively: ~1,316 item images × 703 actions ≈ **0.9 million
redundant `new URL()` parses** on inventory alone, plus the listing
image scan, plus 703 full clones of two large maps. At ~86 ms each
that is the 60 s.

This is the same family as the other investigations (work scoped to
"all of X" when the relevant set is "the few matching Y"), here as a
*performance* rather than *correctness* defect.

## Scope / impact

- **Cold start only.** This cost is paid during full replay /
  state hydration and on the audit page's replay. In live operation
  actions arrive one at a time; 86 ms once is invisible. The pain is
  (a) cold hydrate after a schema-version bump, (b) the audit/replay
  tooling, (c) CI/test replays.
- No correctness issue — the output is right, just slowly produced.

## Recommendations (no behavior change)

In rough order of leverage / smallness:

1. **Memoize `canonicalizeShopifyCdnUrl` (and the
   deleted/non-deleted path variants).** They are pure string→string
   functions; the same ~1,316 item-image URLs are re-parsed 703
   times. A module-level `Map<string,string>` cache collapses ~0.9 M
   `new URL()` parses to ~(distinct URL count). Smallest possible
   change, no behavior impact, likely an order-of-magnitude win on
   this handler.

2. **Short-circuit before cloning.** Compute the small `sourceSet`
   first (already done), then do a cheap pre-scan; only allocate
   `nextIdToItem` / `nextHandleToListing` and do the rewrite when at
   least one item/listing image is in `sourceSet`. Most of the 703
   actions touch only a handful of items, and many touch none.

3. **Maintain a reverse index** `canonicalImageUrl → Set<itemId>`
   (and per-listing) updated incrementally as images change, turning
   the per-action cost from O(all items + all listing images) into
   O(matches). This is the "proper" fix and the biggest change;
   #1 + #2 likely make it unnecessary.

Recommended: ship **#1 + #2** together — both are local to the one
handler, behavior-preserving, and should take the replay from ~82 s
toward roughly ~22 s (removing most of the 60 s). Validate with the
same before/after full-replay state diff used on the inventory fixes
(state must be byte-identical; only timing changes) plus a
profile-replay before/after.

## Reproduction

```bash
bun run scripts/profile-replay.ts 2>&1 | grep -vE \
  "Cached|Loaded|InventoryValidation|RootReducer\]|Skipping|Reducer\]"
```

Look at: "Wall time per 1000-action bucket" (21k–23k spike),
"Cost by action type" (`photos/shopify_cdn_uploaded` ≈ 74%),
"State size growth" (flat ⇒ not O(n)-over-growth), and "30 slowest
individual actions" (all `photos/shopify_cdn_uploaded`, indices
21.5k–23k).

---

## Addendum — post-memoization re-profile (PR #129 merged)

After memoizing the Shopify-CDN URL transforms, the bottleneck moved.
Re-profiled on `main` (memoization merged):

```
Total replay: 81.8 s  →  18.2 s   (4.5x; the 21k–23k spike is gone)
photos/shopify_cdn_uploaded: 60,467 ms (74%)  →  538 ms (~3%)
```

The originally-recommended #2 (short-circuit the clones) and #3
(reverse index) are **retired**: with the handler down to 538 ms,
removing it entirely would save <3% of an 18 s replay while adding
branching to a hot reducer. Memoization captured ~95% of the win.

New #1 cost: **`listingCreation/approve_proposal` — 4,293 ms across
280 actions (~23% of the remaining replay), ~15 ms/action, 54 ms
worst case.**

### What is wrong with approve_proposal

Phase-timed instrumentation on the real backup:

```
field-update loop : 3,789 ms  (99%)
buildDraftListingImages : 6 ms
section 4.5 (handle reconcile) : 19 ms
```

Splitting the field loop further:

```
inventory reducer calls : 3,629 ms  over ~3,288 calls (~1.1 ms each)
  - non-subtype fields : 3,058 ms
  - subtype field      :   587 ms
listings reducer calls  :   164 ms
  - skippable (non handle/description) : only 25 ms
```

So it is **not** the subtype rename and **not** the listings reducer.
The defect is *dispatch fan-out*: the orchestrator emits one
`update_field` per (variant × ~6 fields), driving ~3,288 separate
Immer `produce` passes over the large inventory slice for 280
approvals. Per-call cost is uniform (~1.1 ms) regardless of field.

### Fix

Added `update_fields` (batched, non-re-keying) to the inventory slice,
exactly mirroring the non-subtype `update_field` branch (same field
write + same history entry, per entry, in order). `approve_proposal`
now applies all non-subtype fields for a variant in **one** inventory
produce; the `listings` reducer is invoked only for `handle` /
`description` (the only fields it consumes — all others were verified
no-ops), in original order; `subtype` stays a separate last
`update_field` (it re-keys), with its rekey block unchanged.

Inventory produces/variant: ~6 → 2.

### Result (full Apr 25 replay, atop the merged memoization)

```
approve_proposal total : 4,293 ms  →  1,931 ms   (2.2x; 7.83 → 3.52 ms/variant)
full replay            : ~18.7 s   →  ~16.1 s     (~14% faster)
```

**Behavior proven identical:** a determinism-robust full-state hash
(sorted idToItem incl. image/price/handle/pos/desc, full idToHistory
entries, idToHandle, per-listing sorted image-URL sets) is byte-
identical on `main` and the fix branch across repeated runs
(`15bfb5c4…`). Unit test `tests/unit/update-fields-equivalence.test.ts`
pins `update_fields ≡ sequential update_field`. (The preexisting
`crypto.randomUUID` replay nondeterminism — see PR #129 — is excluded
from the hash and remains a separate future item.)

Beyond this, remaining replay cost is broadly distributed
(`photos/complete_upload`/`complete_edit` ≈ 1.1–1.3 ms over thousands
of actions) — diminishing returns; no further single hotspot.
