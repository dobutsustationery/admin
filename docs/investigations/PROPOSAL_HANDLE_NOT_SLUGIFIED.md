# Spaces in Shopify handles — `listingCreation` proposal handle never slugified

## Scope

User-reported symptom: a listing whose title contains the words
"Kyowa Love & Fur Mini Sticky Notes (75)" carries a Shopify-style
handle that contains literal spaces, capital letters, and `&` —
characters Shopify will not accept in a real handle. Shopify handles
are slugified ASCII: lowercase, hyphens, no whitespace, no `&` or
parentheses.

This investigation walks the Apr 25 production backup replay
(`../production-backup-apr-25/firestore-export.json`) to find which
code path can leave a non-slug string sitting in
`listings.handleToListing`, `listings.idToHandle`, and
`inventory.idToItem[*].handle`, and proposes (without applying) how
to keep it from happening again.

Read-only analysis. No code change in this doc.

## TL;DR

The `listingCreation` slice stores the user-typed value of the
Handle column verbatim, and the `approve_proposal` orchestration
in the root reducer treats `proposal.handle` (whatever it is) as
authoritative — only falling back to `generateHandle()` when
`proposal.handle` is empty. Result: anything the operator types
into the Handle cell of the bulk-create table (`/listings/create`)
propagates unaltered through:

1. `listingCreation.proposals[jan].handle`
2. inventory rows' `handle` field (via `update_field` synthesized
   inside the approve handler)
3. `listings.idToHandle[itemKey]`
4. `listings.handleToListing[<that string>]` — a real listing object
   keyed under the bad handle

There is no validator, no slugifier, and no boundary normalization
anywhere along that chain.

## Worked example: JAN 4969757171813

The user's title `"Kyowa Love & Fur Mini Sticky Notes (75)"` doesn't
appear verbatim in the Apr 25 backup, but the closest match,
`Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)` against JAN
`4969757171813`, is exactly this bug. The trace below uses that JAN;
the title the operator typed today is incidental — what matters is
that a free-form string was put in the Handle column.

### Action sequence

| When (UTC) | Action | Effect |
|---|---|---|
| 2026-03-02 20:25 | `orderImport/import_batch` | Create bare-JAN inventory row, qty 48 |
| 2026-03-18 16:42 | `listingCreation/add_proposals` | Proposal created with title `"Dobutsu Love & Fur Dog Sticky Notes"`, 4 variants (Pomeranian, Poodle, Schnauzer, Shiba) |
| **2026-03-18 16:44** | **`listingCreation/update_proposal_field`** | **`field:"handle", value:"Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"`** ← user typed this |
| 2026-03-18 16:46 | `listingCreation/update_proposal_field` | `field:"title", value:"Dobutsu Love & Fur Dog Mini Sticky Notes (75)"` |
| **2026-03-18 16:52** | **`listingCreation/approve_proposal`** | Materializes 4 sub-typed inventory rows; each row's `handle` field, plus `idToHandle[<each row>]`, plus a new entry in `handleToListing`, all set to the spacey string |
| 2026-03-18 20:50 | `update_listing` | Title edited on the spacey-handle listing |
| 2026-03-18 20:51 (×4) | `update_field({field:"handle", to:""})` | Operator clears handles on each variant — `idToHandle` entries removed, listing under spacey key now orphan |
| 2026-03-18 20:52 (×4) | `update_field({field:"handle", from:"<canonical>", to:"<canonical>"})` | Operator sets handles to the canonical slug `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-4969757171813` — note `from===to`, suggesting the UI emitted these as idempotent identity updates |

By the end of the Apr 25 backup, this particular JAN is self-healed
(the canonical slug appears in `idToHandle`, the spacey listing entry
in `handleToListing` has been swept away by the broader sync, and the
inventory rows carry the canonical slug). But the *time-of-creation*
state — 16:52 through 20:51 — was broken: a real listing keyed under
`"Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"` existed in
`handleToListing`, with all four inventory rows pointing to it.

The user's live symptom for `"Kyowa Love & Fur Mini Sticky Notes (75)"`
is the same shape on a different JAN/proposal that did not get the
manual cleanup treatment.

### Snapshot at approve (showing the bug)

```
inventory.idToItem:
  4969757171813Pomeranian: handle="Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"
  4969757171813Poodle:     handle="Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"
  4969757171813Schnauzer:  handle="Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"
  4969757171813Shiba:      handle="Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"

listings.idToHandle:
  4969757171813Pomeranian → "Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)"
  (… same for the other three)

listings.handleToListing:
  "Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)" → { title: …, variants: … }
```

Shopify would not accept that string as a handle on upload. It would
either reject the request or auto-slugify on its side, producing a
silent mismatch between local handle (spacey) and the handle Shopify
actually persisted. Catalog sync after that would not match by
handle, and `applyHandleUpdate` round-tripping would behave
unpredictably.

## The mechanism, code-locator by code-locator

### 1. UI: handle column is free-form text

`src/routes/listings/create/+page.svelte:424-430`

```ts
{ field: "handle",
  header: "Handle",
  width: 200,
  type: "text",
  placeholderField: "computedHandle" },
```

The placeholder shows `computedHandle` (a `generateHandle(title, jan)`
preview, computed at line 195), but the input itself accepts any
string. There is no `onCommit` slugifier and no inline validator.

### 2. Thunk: handle string passes through verbatim

`src/lib/listing-creation-slice.ts:1671 set_proposal_handle_thunk`

```ts
export const set_proposal_handle_thunk =
  (janCode, variantId, newHandle): AppThunk =>
  (dispatch, getState) => {
    …
    // SCENARIO A / SCENARIO B both end with:
    dispatch(update_proposal_field({
      janCode,
      field: "handle",
      value: newHandle,                 // ← user-typed string, unmodified
    }));
  };
```

### 3. Reducer: store verbatim, no validation

`src/lib/listing-creation-slice.ts:318-331`

```ts
update_proposal_field: (state, action) => {
  const { janCode, field, value } = action.payload;
  if (state.proposals[janCode]) {
    // @ts-ignore - dynamic field access
    state.proposals[janCode][field] = value;
  }
},
```

The reducer doesn't know which field it's writing. It dispatches no
canonicalization for `field === "handle"`.

### 4. Approve orchestration: proposal.handle wins over generateHandle

`src/lib/root-reducer.ts:1751-1752`

```ts
const finalHandle =
  proposal.handle || generateHandle(proposal.title, proposal.janCode);
```

`proposal.handle` is whatever the operator typed. Only when it is
falsy do we fall back to the slug derived from the title. Then
`finalHandle` is fanned out:

`src/lib/root-reducer.ts:1858-1893` (inside the per-variant loop)

```ts
fields.push({ field: "handle", value: finalHandle });
…
fields.forEach((f) => {
  …
  const updateAction = inheritTimestamp({
    ...update_field({ id: currentItemId, field: f.field, from: "", to: f.value }),
    _ephemeral: true,
  });
  nextState = {
    ...nextState,
    inventory: inventory(nextState.inventory, updateAction),
    listings: listings(nextState.listings, updateAction),
  };
});
```

For each variant the orchestrator synthesizes
`update_field({field:"handle", to: finalHandle})` and feeds it to
both the inventory and listings reducers.

### 5. Listings slice: applyHandleUpdate writes whatever it's given

`src/lib/listings-slice.ts:189` (via `update_field` case)
→ `applyHandleUpdate(state, id, newHandle, prevHandle, ts)` at line 378.

That helper writes `state.idToHandle[id] = newHandle` and, if no
listing exists under that handle yet, creates one. It does not
validate, slugify, or check the new handle against `generateHandle`.

## Why the audit's slugifier (`generateHandle`) didn't save us

`src/lib/handle-utils.ts:5-14` defines a perfectly good slugifier:

```ts
export function generateHandle(title: string, jan: string): string {
  const slug = title
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\W-]+/g, "-")     // spaces and non-word chars → -
    .replace(/^-+|-+$/g, "");      // strip leading/trailing -
  return `${slug}-${jan}`;
}
```

But every call site only reaches for it when `proposal.handle` is
empty (a fallback, not a validator). The user-typed string is
considered authoritative the moment it lands in
`proposal.handle`.

## Related: this is the same family as audit row 15

`docs/investigations/GHOST_MISSING_15_AUDIT.md` row 15 and
`docs/investigations/SHOPIFY_IMPORT_OPTION1_PHANTOM_VARIANT.md`
record the broader pattern: identifying/keying fields (subtype,
janCode, handle) are written into reducer state without
canonicalization at the boundary, and downstream consumers then
operate against the verbatim user input. The fix shape is the same
each time: canonicalize on write, not on read.

## Operator intent

The operator typed a candidate listing title into the Handle column
of the bulk-create grid. The Handle column placeholder showed the
canonical slug (because the row had no explicit handle yet); the
operator's edit overwrote that placeholder with a human-readable
string. There is no signal in the UI today that the Handle column
expects a slug, and the column commits the typed value verbatim.

It's a perfectly natural operator error: most spreadsheet-style UIs
in the rest of the app accept free text in similar columns, and the
placeholder is the only hint that this one has different
expectations.

## Why it isn't always-bad in practice

Most listings get their handle from the title pipeline:
`generateHandle(title, jan)` is called when an item or proposal is
first created, so `proposal.handle` is populated with a slug by
default. The hazard only triggers when the operator manually edits
the Handle cell.

We saw exactly that in the trace above: the user did edit the
Handle column on 2026-03-18 at 16:44, after the proposal was
already created with a populated (slug) handle from the prior
flow. The manual edit replaced the slug with a typed title.

## Remediation paths (not implementing here)

Pick one or more; they are independent.

**Code-level fixes (structural):**

1. **Slugify at the boundary**:
   `set_proposal_handle_thunk` should run `newHandle` through
   `generateHandle(newHandle, janCode)`-style normalization before
   dispatch, or reject the action if `newHandle` doesn't match a
   slug regex. Minimal patch, clear ownership, single chokepoint.

2. **Slugify in the reducer**:
   `update_proposal_field` could special-case `field === "handle"`
   and call `generateHandle(value, state.proposals[janCode].janCode)`
   before writing. Catches non-UI dispatches too (any other code
   that emits the action benefits).

3. **Slugify at approve time**:
   `root-reducer.ts:1751` could be
   `const finalHandle = generateHandle(proposal.handle || proposal.title, proposal.janCode)`.
   Catches anything that slipped through earlier validation; safest
   "belt-and-suspenders" choice. But by this point the proposal
   itself has bad data and the UI has been showing the wrong handle
   in preview.

4. **UI-level validation**:
   The Handle column in `/listings/create` could `onCommit` slugify
   the typed value (showing the slugified result back to the user)
   and/or reject the commit if the canonical slug differs from the
   typed value. Best UX, but the data-plane fix above is needed
   regardless to protect against scripted dispatches.

5. **Invariant in `applyHandleUpdate`**: add an assertion that
   `newHandle === generateHandle(<title>, <jan>)` or matches a slug
   regex, and jail the action if not. Same shape as the existing
   `keyAudit.ghostMap` / `canonicalCollisions` instrumentation.

**Data-level fix (one-time):**

- A migration script that walks `handleToListing`, `idToHandle`, and
  `inventory.idToItem[*].handle` for entries whose handle fails a
  slug regex, computes `generateHandle(title, jan)` for each, and
  emits broadcast actions to re-key them. Same shape as a
  rename_subtype/fix_jancode style fixer but operating on the
  handle dimension.

The minimal user-visible fix for the specific live listing
("Kyowa Love & Fur Mini Sticky Notes (75)") is to:

- locate the offending `proposal.handle` (or `idToHandle[itemKey]`,
  whichever holds the spacey string today),
- dispatch a single `update_field({id: <itemKey>, field: "handle",
  from: "<spacey>", to: "<canonical slug>"})` per affected variant,
  and re-sync to Shopify.

This unblocks operations without changing the reducer; the
structural fix (#1 or #2 above) is what stops it from coming back.

## Reproduction

```bash
# Replay the Apr 25 backup and print the state-transition trace for
# JAN 4969757171813 — the closest in-backup match for the user's
# reported listing.
cat <<'EOF' > /tmp/jan-4969757171813.ts
import { readFileSync } from "fs";
import { rootReducer } from "/Users/anicolao/projects/antigravity/admin2/src/lib/root-reducer";

const BACKUP = "/Users/anicolao/projects/antigravity/production-backup-apr-25/firestore-export.json";
const JAN = "4969757171813";

function tsKey(a:any){const ts=a?.timestamp;return ts?._seconds?ts._seconds*1e9+(+ts._nanoseconds||0):ts?.seconds?ts.seconds*1e9+(+ts.nanoseconds||0):0}
const docs:any[] = JSON.parse(readFileSync(BACKUP,"utf-8")).collections.broadcast.documents;
const actions = docs.map((d:any)=>({id:d.id,...d.data})).sort((a:any,b:any)=>tsKey(a)-tsKey(b));
let s:any = rootReducer(undefined,{type:"@@INIT"});
for (const a of actions) { try { s = rootReducer(s, a as any, ()=>{}); } catch{} }
console.log("inventory.idToItem for JAN:");
for (const k of Object.keys(s.inventory.idToItem||{})) if (k.startsWith(JAN)) console.log(" ", k, "→ handle=", JSON.stringify(s.inventory.idToItem[k].handle));
console.log("listings.idToHandle for JAN:");
for (const k of Object.keys(s.listings.idToHandle||{})) if (k.startsWith(JAN)) console.log(" ", k, "→", JSON.stringify(s.listings.idToHandle[k]));
console.log("listings.handleToListing matching this JAN:");
for (const h of Object.keys(s.listings.handleToListing||{})) if (h.includes(JAN) || h.toLowerCase().includes("love & fur")) console.log(" ", JSON.stringify(h));
EOF
bun run /tmp/jan-4969757171813.ts
```

In the Apr 25 backup the operator's manual cleanup runs at
20:51-20:52 land the canonical slug in `idToHandle` and inventory
rows. For a JAN today that has *not* been manually cleaned up, the
same script will print the un-slugified handle and you'll see the
matching entry in `handleToListing`.
