# Variant Updates Review (Live + Draft + Replay)

## Scope Reviewed
- `src/lib/components/ListingEditor.svelte`
- `src/lib/listing-creation-slice.ts`
- `src/lib/root-reducer.ts`
- `src/routes/listing-detail/+page.svelte`

I reviewed the uncommitted variant add/remove changes with specific focus on first-run behavior and broadcast replay determinism.

## Executive Summary
The current change set is **not safe to merge**. It introduces multiple blocking issues:
1. Build/typecheck failures.
2. Non-serializable action broadcast in create mode.
3. Non-deterministic variant IDs generated inside a reducer (breaks replay consistency).
4. Root reducer references `store.getState()` from inside reducer logic (and `store` is undefined).

These issues directly impact the requirement that behavior must work both when first executed and when replayed from broadcast.

## Findings (ordered by severity)

### 1) Critical: create-mode add variant broadcasts a thunk function, not an action
- File: `src/routes/listing-detail/+page.svelte:1498`
- Code path: `dispatchBroadcast(add_variant_thunk(janCode, variantJan));`

`dispatchBroadcast` calls Firestore `broadcast(...)` directly and expects a plain serializable action object. Here it receives a thunk function. This means:
- The action is not representable as a replayable Redux event.
- Broadcast persistence may write malformed docs (missing `type`).
- Replay/dispatch can fail or diverge.

Recommendation:
- Do **not** broadcast thunks.
- Move enrichment logic into reducer interception (intent-action pattern), e.g. broadcast `listingCreation/add_variant_requested` and resolve item selection in root reducer using current state.
- Alternatively, execute thunk locally and ensure it emits only concrete serializable actions that are broadcast.

### 2) Critical: non-deterministic ID generation inside reducer breaks replay
- File: `src/lib/listing-creation-slice.ts:477`
- Code: `crypto.randomUUID()` used in `add_variant` reducer.

Reducers must be deterministic for event replay. Here `variantId` differs across clients/replays. Any later action referencing the original ID (e.g. remove/reorder/edit) can no-op on replay, causing state divergence.

Recommendation:
- Generate `variantId` before dispatch (in action creator) and include it in payload.
- Or derive a deterministic ID from payload + timestamp/event id (stable across replay).
- Keep reducer pure and deterministic.

### 3) Critical: root reducer has invalid reference and impure state source
- File: `src/lib/root-reducer.ts:1012`
- Code: `const prevState = store.getState();`

`store` is not imported/defined in this file (fails typecheck), and using global store from reducer violates reducer purity and replay determinism.

Recommendation:
- Use the `state` argument (pre-action) and `nextState` (post-action) only.
- For remove-variant sync logic, compute from `state.listingCreation` and `nextState.listingCreation` without external reads.

### 4) Critical: current workspace does not compile
`npm run check` reports:
- `src/lib/root-reducer.ts:1012` `Cannot find name 'store'`
- `src/lib/listing-creation-slice.ts:791` duplicate `set_current_step` key
- `src/routes/listing-detail/+page.svelte:1494` `Cannot find name 'readOnly'`
- `src/routes/listing-detail/+page.svelte:1498` `Cannot find name 'add_variant_thunk'`
- `src/routes/listing-detail/+page.svelte:1524` `Cannot find name 'readOnly'`
- `src/routes/listing-detail/+page.svelte:1531` `Cannot find name 'remove_variant'`

Recommendation:
- Resolve all typecheck failures before functional validation.
- Remove duplicate reducer key.
- Fix missing imports/usages in `+page.svelte`.

### 5) High: remove-variant inventory cleanup can compute wrong `from` value
- File: `src/lib/root-reducer.ts:1026`
- Code uses `from: proposal.handle || ""` when clearing inventory `handle`.

`from` should match the item’s current handle, not proposal handle. If they differ, the action audit trail becomes inaccurate and can affect guard logic in reducers that rely on `from` consistency.

Recommendation:
- Use `state.inventory.idToItem[itemId]?.handle || ""` as `from`.

### 6) Medium: draft add/remove flow has no targeted automated tests
No tests were found for the new `add_variant` / `remove_variant` paths or replay behavior.

Recommendation:
- Add unit tests for reducer determinism and root-reducer orchestration.
- Add replay tests that dispatch an action sequence twice into fresh stores and assert identical final state.

## Replay-Safety Recommendations
1. Introduce explicit intent actions:
   - `listingCreation/add_variant_requested`
   - `listingCreation/remove_variant_requested`
2. Resolve all state-derived fields (item selection, handle sync, IDs) inside root reducer using only `(state, action)`.
3. Emit deterministic internal actions with fixed payloads and log them (with propagated timestamp).
4. Prohibit non-plain-object actions from broadcast (`validateAction` should hard-fail if `type` is missing/non-string).

## Suggested Test Matrix
1. Draft mode add same-JAN variant, then rename/reorder/remove; replay action log and compare final state.
2. Draft mode add cross-JAN variant (unlisted inventory item), verify inventory handle linkage and replay equivalence.
3. Live mode add/remove variant via `update_field(handle)` and confirm listing membership updates correctly.
4. Sequence test: add -> edit subtype -> remove; ensure remove always targets existing variant ID after replay.
5. Negative test: malformed action (missing `type`) is rejected by broadcast validation.

## Ship Recommendation
- **Do not ship yet.**
- Fix critical items 1-4 first, then add replay-focused tests before merge.
