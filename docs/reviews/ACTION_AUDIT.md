# ACTION_AUDIT

## Scope

This audit covers actions that are persisted via `broadcast(...)` writes to Firestore.

Primary persistence entrypoint:

- `src/lib/redux-firestore.ts:42`

Primary callsites:

- `src/routes/listings/create/+page.svelte`
- `src/routes/listing-detail/+page.svelte`
- `src/routes/photos/+page.svelte`
- `src/lib/components/PhotoUploadManager.svelte`
- `src/routes/photo-history/+page.svelte`
- `src/routes/order-import/+page.svelte`
- `src/routes/shopify-import/+page.svelte`
- `src/routes/shopify-products/+page.svelte`
- `src/routes/order/+page.svelte`
- `src/lib/InventoryRow.svelte`
- `src/lib/SubtypeRow.svelte`
- `src/lib/InventoryScanner.svelte`
- `src/lib/ComboBox.svelte`
- `src/routes/archives/+page.svelte`
- `src/routes/shows/+page.svelte`
- `src/routes/names/+page.svelte`
- `src/routes/sku-review/+page.svelte`

## Clean vs Dirty Criteria

- `clean`: payload carries user-entered intent and/or external non-deterministic output (AI output, upload URLs), with no redundant store snapshot data.
- `dirty`: payload includes computed/derived data (including identity copies from current store), UI-only state, or values that should be reducer-derived.

---

## Correctly Implemented (Clean)

### Names

- `create_name`
- `remove_name`

Reason:

- Pure user input (`id`, `name`).

### Inventory and Order Actions (mostly intent)

- `package_item`
- `quantify_item`
- `delete_empty_order`
- `archive_inventory`
- `hide_archive`
- `hide_exception`
- `show_exception`

Reason:

- User intent actions with minimal payload.

Note:

- `make_sales` is not clean (see dirty section) due to client-computed `date`.

### Import Session/Command Actions (intent-oriented)

- `orderImport/start_session`
- `orderImport/set_header`
- `orderImport/append_raw_rows`
- `orderImport/mark_items_done`
- `orderImport/clear_import`
- `orderImport/finish_import`
- `orderImport/import_batch`
- `shopifyImport/start_session`
- `shopifyImport/set_header`
- `shopifyImport/append_raw_rows`
- `shopifyImport/mark_items_done`
- `shopifyImport/clear_import`
- `shopifyImport/finish_import`
- `shopifyImport/import_batch`

Reason:

- These represent file/session intent and operator commands; derived updates happen in reducers (`src/lib/root-reducer.ts:355`, `src/lib/root-reducer.ts:409`).

### Listing content edits (user/AI content itself is clean)

- `listingCreation/update_proposal_field` when used for:
  - title/body/category/vendor/tags/option name/prompt text.
- `listingCreation/update_variant_value`
- `listingCreation/update_variant_qty`
- `listingCreation/update_variant_image`
- `listingCreation/add_listing_only_image`
- `listingCreation/remove_listing_only_image`
- `listingCreation/include_proposal_photo`
- `listingCreation/exclude_proposal_photo`
- `listingCreation/reorder_variants`
- `listingCreation/merge_proposals`
- `listingCreation/move_variant`
- `listingCreation/split_variant`
- `listingCreation/import_existing_variants`
- `listingCreation/approve_proposal`

Reason:

- These are mostly user intent or AI content edits.

Important caveat:

- Some callsites still inject computed snapshots into these actions (see dirty section under "mixed").

### Listing live actions

- `update_listing` (field-level changes)
- `add_listing_image`
- `remove_listing_image`

Reason:

- User intent on listing model.

---

## Wrong / Dirty (Needs Fix)

## 1) Hard regression root cause

- `listingCreation/add_proposals` (dirty)

Why:

- Carries fully computed proposals, including computed allocation qty (`qty`), generated IDs, and merged snapshot-like content.
- Computed allocation is done in thunk, not reducer:
  - `src/lib/listing-creation-slice.ts:1051`-`src/lib/listing-creation-slice.ts:1099`
  - dispatched at `src/lib/listing-creation-slice.ts:1133`
- Persisted because generate flow uses `dispatchBroadcast`:
  - `src/routes/listings/create/+page.svelte:315`
  - `src/routes/listings/create/+page.svelte:301`-`src/routes/listings/create/+page.svelte:307`

Impact:

- Event log stores computed values (e.g., wrong `qty: 40`) instead of intent.

## 2) Mixed actions currently persisted with dirty payload fields

- `update_item` (mixed, often dirty)
  - In several flows it is sent as a near-full item snapshot (`{ ...existingItem, ...changes }`), which duplicates state and includes derived fields.
  - Example patterns:
    - migration/update flows in `src/routes/shopify-import/+page.svelte:96`
    - conflict resolution payload construction in import pages.
  - Should prefer minimal patch intent over full record snapshots.
- `update_field` (dirty as used now)
  - Payload includes `from` copied from store at callsite (`src/lib/InventoryRow.svelte:27`, `src/routes/listing-detail/+page.svelte:464`, etc.).
  - `from` is identity-computed and not needed for deterministic replay.
- `retype_item` (dirty as used now)
  - Includes `qty` and `janCode` copied from current state (`src/routes/order/+page.svelte:87`-`src/routes/order/+page.svelte:94`).
  - Should be intent-only (e.g., target subtype); qty can be reducer-derived from order line.
- `orderImport/resolve_conflict` and `shopifyImport/resolve_conflict` (dirty)
  - Payload embeds full computed `resolvedActions` arrays produced in UI, often with copied existing values:
    - `src/routes/order-import/+page.svelte:573`
    - `src/routes/shopify-import/+page.svelte:738`
  - This bypasses reducer computation boundary and persists decision output rather than decision intent.

## 3) Persisted UI/ephemeral process state

- `listingCreation/set_current_step`
- `listingCreation/set_scan_progress`
- `listingCreation/set_scanning`
- `listingCreation/set_drive_connection_status`
- `photos/begin_categorize`
- `photos/end_categorize`
- `ui/set_column_width` (arguable; user preference, but still UI-only)

Why:

- These are navigation/progress/connectivity/view-state, not durable business events.

## 4) Snapshot/derived collection writes

- `photos/select_photos` (dirty in current shape)

Why:

- Persisted payload is a full selected-photo array, often merged with current state (`replace` vs `add`) and includes volatile URLs.
- This is effectively a state snapshot, not minimal intent.
- Call examples:
  - `src/routes/photos/+page.svelte:510`
  - `src/routes/photos/+page.svelte:589`
  - `src/routes/photos/+page.svelte:653`
  - `src/routes/photos/+page.svelte:679`

## 5) Client-computed timestamp fields in payload

- `make_sales({ archiveName, date: new Date() })` at `src/routes/shows/+page.svelte:49`
- `listingCreation/start_batch({ ..., createdAt: Date.now() })` at `src/routes/listings/create/+page.svelte:330`
- `photos/initiate_upload({ ..., timestamp: Date.now() })` in upload flows

Why:

- Event already has authoritative Firestore server timestamp.
- Persisting client-generated timestamps adds duplicate computed values and potential clock skew.

---

## Additional Problem: Audit Export Pollution

- Audit export path attaches derived `children` into exported JSONL:
  - children generation: `src/routes/audit/+page.svelte:54`-`src/routes/audit/+page.svelte:70`
  - attachment: `src/routes/audit/+page.svelte:86`
  - export: `src/routes/audit/+page.svelte:214`

Why this matters:

- Exported replay files may contain non-broadcast derived data (`children`), which can cause duplicate application in external replay tools.

---

## Recommended Event Boundary Changes

## High priority

- Stop persisting `listingCreation/add_proposals`.
- Replace with intent event(s), then compute proposals in reducer from state at replay time.

## High priority

- Remove `from` from persisted `update_field` payload.
- Move any "old value for audit text" derivation into reducer/logger.

## High priority

- Replace `resolve_conflict(...resolvedActions)` with intent-only conflict resolution payloads (field choices, selected target IDs), and compute resulting updates in reducers.

## Medium priority

- Make UI/process actions local-only (`set_current_step`, scan progress/flags, categorize begin/end, maybe column widths).

## Medium priority

- Convert "full snapshot" payloads (`photos/select_photos`) to append/remove intent events where possible.

## Medium priority

- Avoid payload timestamps generated in UI (`Date.now()`, `new Date()`); rely on event timestamp metadata.

---

## Action Inventory Summary

## Clean

- `create_name`, `remove_name`
- `package_item`, `quantify_item`, `delete_empty_order`, `archive_inventory`, `hide_archive`, `hide_exception`, `show_exception`
- `orderImport/*` and `shopifyImport/*` session/command actions (except conflict payload shape issues noted)
- Listing content/intent edits listed above, when payload is not carrying computed snapshots.
- `update_listing`, `add_listing_image`, `remove_listing_image`

## Dirty / wrong

- `listingCreation/add_proposals`
- `make_sales` (client-side `date` in payload)
- `update_item` (when used as full snapshot payload)
- `update_field` (due to persisted `from`)
- `retype_item` (callsite-computed duplicate fields)
- `orderImport/resolve_conflict` and `shopifyImport/resolve_conflict` (persisted computed action plans)
- `photos/select_photos` snapshot payload
- UI/process state actions listed above
- client timestamp fields in payload (`createdAt`, `date`, upload `timestamp`)
