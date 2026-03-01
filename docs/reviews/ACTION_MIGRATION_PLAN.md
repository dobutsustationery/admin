# ACTION_MIGRATION_PLAN

## Goal

Move all persisted broadcast actions to an intent-only event model:

- no computed values in payload
- no duplicated store snapshots
- reducers derive computed state deterministically

---

## Phase 0: Ground Rules

1. Persist only user intent or external nondeterministic outputs (AI text, uploaded asset URL).
2. Do not persist UI state (`current step`, progress bars, connection status, local timestamps).
3. Do not persist `from` fields or full object snapshots if reducer can derive current value.
4. Use Firestore event timestamp as authoritative time; avoid `Date.now()` in payload.

---

## Phase 1: High-Risk Fixes First

## 1) Replace `listingCreation/add_proposals`

Current:

- stores full computed proposals including computed qty and generated IDs.

Target:

- introduce `listingCreation/generate_proposals_intent` with minimal payload:
  - source jan keys / selection scope
  - optional prompt overrides
- reducer/interceptor computes proposals from current state.

Compatibility:

- keep handler for legacy `add_proposals` during migration window.
- mark deprecated and stop broadcasting it from UI immediately.

## 2) Remove computed `resolvedActions` from conflict events

Current:

- `orderImport/resolve_conflict` and `shopifyImport/resolve_conflict` persist precomputed action arrays.

Target:

- persist resolution intent only:
  - row index
  - per-field choice (`incoming` or `existing`)
  - target match key when needed
- reducer computes resulting inventory/listing updates.

Compatibility:

- support both schemas in root reducer.

## 3) Stop persisting `update_field.from`

Current:

- persisted `from` is copied from store at callsite.

Target:

- payload = `{ id, field, to }`
- reducer computes previous value internally for history text.

Compatibility:

- allow optional `from` for old events, ignore when absent.

---

## Phase 2: Remove Snapshot-Style Events

## 4) Replace `photos/select_photos` full snapshots

Current:

- persists full selected list (often merged with current state).

Target:

- new intent events:
  - `photos/selection_replace { ids | sourceSessionId }`
  - `photos/selection_add { ids }`
  - `photos/selection_clear {}`
- resolver builds selected state in reducer.

## 5) Replace snapshot-style `update_item` usage

Current:

- several flows send full `{ ...existingItem, ...changes }`.

Target:

- patch/intention actions:
  - `inventory/adjust_qty`
  - `inventory/set_fields`
  - `inventory/set_image`
  - `inventory/set_pricing`
- keep `update_item` only for true full-source import record events.

---

## Phase 3: Ephemeral/UI De-Persistence

Stop broadcasting these:

- `listingCreation/set_current_step`
- `listingCreation/set_scan_progress`
- `listingCreation/set_scanning`
- `listingCreation/set_drive_connection_status`
- `photos/begin_categorize`
- `photos/end_categorize`
- optionally `ui/set_column_width` (if kept, treat as preference channel, not domain event channel)

Use:

- local store dispatch only, or a separate preferences persistence path.

---

## Phase 4: Timestamp Hygiene

Remove payload timestamps where redundant:

- `listingCreation/start_batch.createdAt`
- `make_sales.date` (if business date needed, use explicit user-entered date)
- upload initiation timestamps in payload

Use:

- server event timestamp metadata for ordering/audit.

---

## Phase 5: Audit Export Safety

Problem:

- exported logs may include derived `children`.

Fix:

- export only canonical broadcast fields.
- strip `children` and any computed/derived display fields from exports.
- add a replay validator to reject non-canonical keys.

---

## Suggested Execution Order

1. Stop broadcasting `listingCreation/add_proposals`; add intent event + reducer compute.
2. Convert conflict resolution events to intent-only.
3. Drop `from` from `update_field`.
4. Convert photo selection to replace/add/clear intent events.
5. prune UI/ephemeral broadcasts.
6. clean timestamps.
7. enforce export schema.

---

## Verification Checklist

1. Replay old logs still succeeds (backward compatibility path).
2. Replay new logs yields deterministic identical state.
3. `kalita-fail-3-660pics.jsonl` no longer reproduces doubled allocation from persisted computed qty.
4. No persisted event payload contains:
   - generated IDs derived only from current state
   - reducer-computable totals/allocations
   - full copied records where patch intent is sufficient
5. Audit export contains canonical events only.
