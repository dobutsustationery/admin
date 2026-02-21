# CODEX Image Bug Analysis

## Fourth Review (Latest)

I reviewed the latest Gemini fixes again and re-ran the image-related unit tests.

### Findings

- No blocking defects found in the draft-to-approved image pipeline in current code.
- The previously identified issues appear resolved:
  - sibling proposal lookup during approval now uses proposal objects directly (not JAN-key remap), including split-keyed proposals (`src/lib/store.ts:400-427`)
  - draft builder input dedupes primary proposal (`src/routes/listing-detail/+page.svelte:150-155`)
  - gallery filtering uses effective variant image (`variantImage || image`) (`src/lib/components/ListingEditor.svelte:32-39`)
  - `sourceGroup` metadata is preserved for replace/remove routing (`src/lib/listing-image-logic.ts:51-58`)

### Validation

Executed:
- `npx vitest run tests/unit/listing-creation-approve.test.ts tests/unit/listing-creation-split.test.ts tests/unit/listing-image-ordering.test.ts`
- `npx vitest run tests/unit/listing-creation-*.test.ts tests/unit/listing-image-ordering.test.ts`

Result:
- all passed (no failing tests in this set)

### Remaining risk (non-blocking)

- Confidence is strong for the covered paths, but this is still unit coverage only. If you want full closure, run one focused e2e repro for:
  1. split variant -> add/reorder/remove images -> approve
  2. merged handle siblings -> approve from one sibling
