# Image Pipeline Review (Fresh Pass)

## Findings (ordered by severity)

### 1) [BLOCKER] Processing config is overwritten on every hydrate, so user config does not persist

- `src/lib/root-reducer.ts:108` checks `Array.isArray(oldConfig.steps)`.
- New config shape also uses an array (`steps: ProcessingStep[]`), so this condition is true for both old and new formats.
- Result: hydration resets config back to defaults (`crop=false, color_correct=true, remove_background=true`) every time.

Impact:

- Configurable pipeline is not actually persistent across reload/replay.
- User changes in modal can appear saved briefly, then revert on next hydration.

Recommendation:

- Migrate by validating element shape (string vs `{ type, enabled }`), not by `Array.isArray`.

### 2) [HIGH] `remove_background` completion from worker does not set done status in client queue

- Worker broadcasts operation as transform name, e.g. `remove_bg`:
  - `functions/shared/photos-sync-worker.cjs:224`
- Client queue tracks status key as `remove_background`:
  - `src/lib/photos-slice.ts:358`
- `photos/+page.svelte` now relies on worker broadcast for non-idempotent completion:
  - `src/routes/photos/+page.svelte:440`

Impact:

- `remove_background` jobs can complete but remain unchecked in `edits[id].status`.
- Subsequent runs can reschedule background removal unnecessarily.

Recommendation:

- Normalize operation naming at one boundary:
  - Either worker emits `remove_background`,
  - Or slice maps `remove_bg` -> `remove_background` before status update.

### 3) [MEDIUM] New E2E test is stale against current modal DOM and defaults

- Test selects `.space-y-2 > div`:
  - `e2e/014-photos/processing-pipeline.spec.ts:39`
- Modal now renders `.steps-list` / `.step-row`:
  - `src/lib/components/ProcessingConfigModal.svelte:77`
- Test expects initial order `Crop, Background, Color`:
  - `e2e/014-photos/processing-pipeline.spec.ts:38`
- Current default is `Crop (disabled), Color, Background`:
  - `src/lib/photos-slice.ts:63`

Impact:

- Coverage added for this feature is likely failing or not asserting real behavior.

Recommendation:

- Update selectors and expected default ordering/enabled states.
- Add assertion that persisted config survives a hydrate cycle.

## What Looks Good

- Worker now emits `photos/complete_edit` for transform completions, reducing duplicate client-side completion dispatching (`functions/shared/photos-sync-worker.cjs:218`).
- Step enable/disable + reordering UI is cleanly wired into store state (`src/lib/components/ProcessingConfigModal.svelte`, `src/routes/photos/+page.svelte:1157`).
- Idempotency transform versioning was expanded (`crop_v3`) and shared between client/server utils.

## Validation Performed

- `npm run check`: pass
- `npm test -- tests/unit/photos-slice.test.ts`: pass

## Overall Recommendation

- Not ready to merge yet due to findings #1 and #2.
- Fix those two first, then rerun `check`, unit tests, and pipeline E2E.
