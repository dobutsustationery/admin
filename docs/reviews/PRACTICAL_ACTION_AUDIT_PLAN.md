# Practical Action Audit Plan

Scope: only these three actions

- `listingCreation/add_proposals`
- `orderImport/resolve_conflict`
- `photos/select_photos`

Constraints accepted:

- No legacy normalizer for this scope (these events are not in production data).
- `photos/select_photos` must stay persisted for cross-device resume and multi-user collaboration.

## Goals

1. Persist only irreducible user or AI intent.
2. Move all computed or duplicate values into reducers/selectors.
3. Add write-time guards so dirty payloads cannot be broadcast.

## Action-by-action plan

### 1) `listingCreation/add_proposals`

Current problem pattern:

- Persisted payload includes proposal structures with computed quantities (e.g. merged/allocated `qty`).

Plan:

- Redefine persisted payload to include only proposal generation/edit intent:
  - prompt/input text
  - proposal identifiers
  - user edits to proposal source content
  - model metadata needed for reproducibility (if required)
- Remove any persisted fields representing computed allocation/merge results.
- Compute proposal quantities and merged allocation totals only in reducer/derived state.
- Add schema validation in broadcast path:
  - reject payloads containing computed fields like `variants[].qty` when those values are derivable.

Acceptance criteria:

- Replaying proposals never depends on persisted computed qty.
- Regression scenario (`test-data/kalita-fail-3-660pics.jsonl`) produces allocation 20, not 40.

### 2) `orderImport/resolve_conflict`

Current problem pattern:

- Payload may include materialized `resolvedActions` (computed output) rather than conflict-resolution intent.

Plan:

- Persist only conflict resolution intent:
  - conflict identifier(s)
  - selected resolution strategy
  - explicit user overrides
- Stop persisting `resolvedActions` or any computed action list.
- Recompute resolved actions in reducer at replay time from intent + current store state.
- Add schema validation:
  - reject `resolvedActions` and similar materialized computed outputs.

Acceptance criteria:

- Event payload is stable and minimal.
- Reducer deterministically reconstructs results from intent.

### 3) `photos/select_photos`

Requirement:

- Must remain persisted so users can resume across devices and collaborate.

Plan:

- Keep action persisted, but limit payload to collaboration-relevant user intent:
  - selected photo IDs
  - optional ordering/group IDs if directly user-authored
  - actor/session metadata as needed
- Remove derived/denormalized structures from payload (e.g. computed `children` trees).
- Compute hierarchical/derived photo views (`children`, group expansions, UI projections) in reducer/selectors.
- Add schema validation:
  - reject derived structures that can be rebuilt from selected IDs + store state.

Acceptance criteria:

- Cross-device/collab state remains correct.
- Payload contains only user-authored selection intent, not computed tree data.

## Implementation steps

1. Introduce per-action payload schemas for the three actions.
2. Update all dispatch/broadcast writers to emit only schema-approved fields.
3. Refactor reducers/selectors to derive all computed state currently persisted by these actions.
4. Add tests:
   - writer rejects dirty payload fields
   - reducer computes expected derived values from clean payload
   - listing qty regression test confirms no doubling
5. Add lightweight telemetry/logging for rejected dirty writes during rollout.

## Non-goals

- No migration or legacy compatibility layer for these three actions in this plan.
- No changes to unrelated broadcast actions.

## Review checklist

- For each action: "Could this field be recomputed from current store + intent?"
  - If yes: remove from persisted payload.
  - If no: keep as persisted intent.
- Confirm no persisted field duplicates existing authoritative store value.
- Confirm cross-device/collab requirements remain satisfied (especially photos flow).
