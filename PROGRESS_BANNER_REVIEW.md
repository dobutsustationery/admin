# Progress Banner Review

## Scope Reviewed
- Commit: `68ca92c` ("Implement sticky progress banner container")
- Files reviewed:
  - `src/lib/banner-store.ts`
  - `src/lib/components/StickyBannerContainer.svelte`
  - `src/lib/components/BatchProgressBanner.svelte`
  - `src/lib/components/CategorizationProgressBanner.svelte`
  - `src/lib/components/UploadProgressBanner.svelte`
  - `src/routes/+layout.svelte`
  - `src/routes/photos/+page.svelte`
  - `src/routes/photo-history/+page.svelte`

## Findings

### 1. Medium: Banner identity API is fragile across producers
**Where**
- `src/lib/banner-store.ts:14`
- `src/lib/banner-store.ts:21`

**Issue**
The store is keyed only by a global string `id`, and `unregister(id)` removes any banner with that id regardless of who registered it. This works for current hardcoded ids, but it is brittle as more pages/features add banners.

If two producers ever reuse an id (or one feature mounts twice), one producer can silently remove another producer's active banner.

**Recommendation**
- Make registration ownership explicit:
  - `register(...)` returns a unique token/disposer, and unregister uses that token, or
  - Namespace ids by producer and enforce uniqueness via helper constants.
- Add a guard/log when a different producer overwrites an existing id.

### 2. Medium: High-frequency redundant store writes while progress is active
**Where**
- `src/routes/photos/+page.svelte:222`
- `src/routes/photo-history/+page.svelte:237`
- `src/lib/banner-store.ts:14`

**Issue**
Banner registration is done inside broad reactive blocks. In `photos/+page.svelte`, the registration payload includes `registry`, `photos`, and `janCodeToPhotos`, so many unrelated store updates will re-run `register(...)`. Each call mutates `activeBanners` even when the same banner is already present.

This creates unnecessary churn and extra re-renders in the global sticky container during already busy operations.

**Recommendation**
- Avoid unconditional re-register on every reactive pass:
  - Track previous banner payload and only register when meaningful inputs change, or
  - Add `upsertIfChanged` logic in `banner-store` (shallow compare id/priority/component/props ref), and no-op if unchanged.
- Keep props minimal for progress rendering (avoid passing large collections unless required for UI).

### 3. Low: No automated coverage for banner lifecycle and stacking behavior
**Where**
- No tests found referencing `activeBanners` / `StickyBannerContainer` / progress banner ids.

**Issue**
The behavior is lifecycle-heavy (mount/unmount, route transitions, concurrent banners with priorities), but there is no test coverage for these regressions.

**Recommendation**
Add focused tests for:
- Register/unregister lifecycle on route enter/leave.
- Priority ordering (upload > categorize > batch edit).
- No stale banners after operation completion or component destroy.
- Coexistence with `SyncQueueStatusBar`.

## Overall Assessment
No blocker-level correctness issue found in this patch. The implementation compiles cleanly (`npm run check` passes) and the architecture direction is good, but the banner store contract and update frequency should be tightened to prevent future cross-feature regressions and runtime UI churn.
