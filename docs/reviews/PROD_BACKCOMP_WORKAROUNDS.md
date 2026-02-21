# Production Backward-Compatibility Workarounds

Source data: `test-data/firestore-export.json` (3,700 broadcast docs)
Intersection source: `ACTION_AUDIT.md` dirty list vs production action types
Computed by: `scripts/dirty-action-intersection.mjs`

## Dirty actions found in production

- `update_item`: 1,225
- `update_field`: 456
- `retype_item`: 250
- `make_sales`: 1

Not present in production export:

- `listingCreation/add_proposals`
- `orderImport/resolve_conflict`
- `photos/select_photos`

## Required compatibility behavior

### 1) `update_item` (full item snapshot payload)

Observed shape in production:

- All 1,225 have `payload.item`
- All 1,225 include `item.qty`
- 106 include `item.shipped`

Workaround requirements:

- Continue replay support for legacy full-snapshot `update_item` events.
- Treat legacy `update_item` as an intent to patch listed fields onto existing item state, not as canonical source-of-truth for computed/store-derived fields.
- If migrating to intent-only events, keep a legacy decoder path that maps old snapshots to the new reducer input.

Risk if not handled:

- Historical sessions fail to replay correctly or diverge from current state.

### 2) `update_field` (`from` + `to` duplication)

Observed shape in production:

- 456/456 include both `from` and `to`
- Fields used: `description` (139), `qty` (60), `hsCode` (195), `image` (28), `pieces` (34)

Workaround requirements:

- Keep accepting `from` in persisted legacy events, but ignore it for state computation.
- Reducers should derive previous value from current state; only apply `to` as mutation intent.
- For new writes, stop persisting `from` entirely.

Risk if not handled:

- Replay can trust stale duplicated values and diverge when prior actions are reordered/replayed.

### 3) `retype_item` (computed/duplicated payload fields)

Observed shape in production:

- 250/250 include `qty`, `janCode`, `subtype`

Workaround requirements:

- Preserve legacy replay support for these events.
- In reducer, treat duplicated fields as optional hints and recompute/derive authoritative values from store context where applicable.
- For new events, persist only minimal intent required to perform retype.

Risk if not handled:

- Historical replays become brittle if payload duplicates conflict with reconstructed state.

### 4) `make_sales` (non-serialized date object)

Observed shape in production:

- 1 event, with `payload.date` as `object`

Workaround requirements:

- Add permissive date normalization in replay: accept object, timestamp-like, or ISO string and coerce to canonical internal date.
- New writes should serialize date deterministically (e.g. ISO string).

Risk if not handled:

- Replay/parser failure on this historical event.

## Practical migration approach

1. Add a versioned event normalizer layer before reducers.
2. Normalize only known legacy dirty actions above.
3. Keep reducers as the only place where computed values are derived.
4. Gate all new event writes with a schema check: reject computed/duplicated fields.

## What this means for listing creation regression

- `listingCreation/add_proposals` is dirty by design, but it does not appear in the production export snapshot.
- Backward compatibility work should prioritize the four dirty action types above.
- Fixing listing creation to stop persisting computed quantities can be done without production data migration for this export set.
