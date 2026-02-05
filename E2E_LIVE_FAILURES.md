# Live E2E Failure Analysis

## Run Details

Executed with live env loaded and fresh build:

```bash
npm run build:local
set -a && source .env.live.local && set +a
npm run test:live:e2e
```

Result:
- `setup` project passed (`auth.setup.ts`)
- 2 test specs failed:
  - `e2e/live/001-photo-processing/001-photo-processing.spec.ts`
  - `e2e/live/002-journey/002-journey.spec.ts`

## Failure 1: `001-photo-processing` timeout waiting for store hook

Observed failure:
- test times out at:
  - `await page.waitForFunction(() => !!window.__store);`
- page is fully loaded (dashboard rendered), but `window.__store` never appears.

Why this happens:
- This spec relies on a brittle hook (`window.__store`) that is not guaranteed.
- The app already exposes a stable E2E hook in emulator/live preview via `window.testHelpers.store`.
- `002-journey` already uses fallback (`window.__store || window.testHelpers?.store`); `001` does not.

Right fix:
- Update `001-photo-processing` to use the same robust lookup:
  - wait for `window.testHelpers?.store` (or fallback chain)
  - dispatch via whichever store is available
- Prefer `testHelpers` as primary hook for all live tests.

## Failure 2: `002-journey` incorrect thumbnail count assertion

Observed failure:
- Expected selected thumbnail count = fetched photo count (`1`)
- Actual count found in locator = `9`

Failing selector:
- `getByTestId('selection-area').locator('[data-testid^="photo-thumbnail-"]')`

Why this happens:
- `selection-area` contains more than just uncategorized selected thumbnails.
- Categorized thumbnails also match the same `data-testid^="photo-thumbnail-"` pattern.
- So the assertion is counting both selected + categorized items.

Right fix:
- Add dedicated test IDs for containers:
  - selected queue container (uncategorized)
  - categorized groups container
- Update test to count only selected queue thumbnails, not all thumbnails under `selection-area`.

## Additional Hardening Recommended

1. Add a `photos/reset` test action to clear both `selected` and `janCodeToPhotos` between tests.
2. Use deterministic selectors in live tests (never broad prefix matches across multiple regions).
3. Keep visual assertions out of early live flow checks unless the surface is intentionally frozen.
