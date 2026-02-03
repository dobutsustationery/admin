# Extra Album Analysis

Short answer: this is from the current live E2E sandbox design/implementation, not random behavior from Google Photos.

## What is creating `Sandbox_*` albums

- `e2e/live/global-setup.ts` runs `scripts/google-fixtures/create-run-sandbox.ts` at the start of each live Playwright run.
- `create-run-sandbox.ts` creates:
  - a Drive folder named `Sandbox_<timestamp>_<runId>`
  - a Photos album with the same name
- So every live run creates a new Photos album by design.

## Why there are many and why they are empty

- The sandbox creator script creates the album immediately, before any media staging into that album.
- If a run fails early (or does not copy media into sandbox albums), the album remains empty.
- Repeated runs therefore accumulate many empty `Sandbox_*` albums.

## Why cleanup is not removing them

- `e2e/live/global-teardown.ts` only deletes the Drive sandbox folder (via `cleanup-run-sandbox.ts <folderId>`).
- `scripts/google-fixtures/cleanup-run-sandbox.ts` explicitly does **not** delete Photos albums; it warns that Photos cleanup is manual.
- So Photos albums are expected to accumulate with the current implementation.

## Is this a Gemini idea or part of the design?

- It is consistent with the design direction (per-run sandbox isolation for live tests).
- The specific operational gap (Drive cleanup only, Photos album accumulation) is an implementation limitation acknowledged in the current scripts/comments.
