# Schema Hydration Review (`ec94f85`)

## Findings (ordered by severity)

### 1) [BLOCKER] Schema-mismatch path discards state snapshot but still uses old `snapshotMetadata`, which can skip required replay actions

What changed:
- On `HYDRATE`, reducer now discards hydrated state when `schemaVersion` mismatches:
  - `src/lib/root-reducer.ts:110`

Problem:
- `hydrate()` still sets `snapshotMetadata` from the loaded snapshot unconditionally after dispatching `HYDRATE`:
  - `src/lib/store.ts:43`
- Broadcast replay then filters out all actions at/before that stale snapshot timestamp/id:
  - `src/routes/+layout.svelte:192`
  - `src/routes/+layout.svelte:205`

Why this breaks the approach:
- The new design intends to “discard snapshot and force full replay.”
- In practice, stale `snapshotMetadata` can prevent that full replay by skipping historical actions, leading to incomplete reconstructed state.

Recommendation:
- Only set `snapshotMetadata` when hydration is accepted.
- If schema mismatch is detected, clear or ignore `snapshotMetadata` for this session (and ideally clear the stored snapshot), so replay starts from the beginning of the action log.

## Overall
- The schema-version direction is solid and simpler than ad-hoc migrations.
- Fixing the replay gate issue above is necessary before treating this as safe.
