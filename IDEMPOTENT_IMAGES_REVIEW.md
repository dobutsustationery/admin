# Review: Idempotent Image Transforms & Durable Registry (d8c1985)

## Summary

The implementation in `d8c1985` delivers a solid foundation for the idempotent image system described in `docs/design/IDEMPOTENT_IMAGES.md`. The core derivation-key mechanism and server-side "Search Before Work" pattern are correctly implemented. However, there are incomplete areas, a few bugs, and several design-vs-implementation gaps worth noting.

---

## What Was Implemented Well

### Derivation Key Infrastructure (Step 1 — Complete)
- `generateDerivationKey(type, id, transform)` is implemented in both `google-drive.ts` (client, typed) and `photos-sync-worker.cjs` (server, untyped but equivalent). The `{source_type}:{source_id}:{transform_name}` format matches the spec exactly.
- `findFileByDerivationKey()` is implemented on both client and server, using `appProperties has { key=... and value=... }` Drive API queries.
- `uploadImageToDrive()` now requires a `derivationKey` parameter, stamping every uploaded file with `appProperties.derivation_key`. This enforces the design goal that "no untracked uploads" should exist.
- `uploadCSVToDrive()` was updated to accept an optional `derivationKey`, a reasonable extension beyond the spec.

### Server-Side Idempotency (Step 2 — Mostly Complete)
- The "Search Before Work" pattern in `executeTransfer()` is correctly implemented: the worker searches by derivation key before downloading/uploading, short-circuiting with `emitSuccess()` if a match is found.
- The `emitSuccess()` helper is a good refactoring — it deduplicates the completion event + broadcast action logic that was previously inlined.
- The worker now routes `photos/image_transform_requested` events through `handleTransferRequested`, correctly expanding the event type handling.
- Failure in the pre-work search is non-fatal (`catch` logs a warning and falls through to perform the work), which is the right defensive behavior.

### Gemini Client Alignment (Step 3 — Partially Complete)
- The `removeBackground` import and all client-side image processing logic have been removed from `gemini-client.ts`. This is a large, positive deletion (~70 lines of complex fetch/upload/fallback code removed).
- The client now checks for already-processed images via `findFileByDerivationKey` using `generateDerivationKey("photos", img.id, "remove_bg")`.

### Client-Side Idempotency (Bonus — Not in Spec)
- `PhotoUploadManager.svelte` gained a client-side pre-check: before dispatching a sync request, it calls `findFileByDerivationKey` to resolve already-transferred images immediately. This is an optimization beyond the spec (the design says "the client can remain naive"), but it avoids unnecessary sync queue writes and is harmless.

### All Upload Call Sites Updated
Every `uploadImageToDrive` caller was updated to pass a `derivationKey`:
- `listing-detail/+page.svelte`
- `photo-history/+page.svelte` (two call sites)
- `photos/+page.svelte`
- `shopify-import/+page.svelte`
- Both live test files

---

## Issues & Gaps

### 1. Transform Backend Is Stubbed — Not Implemented (Critical)

**Design says (Step 2):** "Add support for a new `photos/image_transform_requested` event type to handle idempotent edits. All transformation logic (background removal, cropping, etc.) will be performed by backend workers."

**Reality:** The worker routes `image_transform_requested` to `executeTransfer()`, but the actual transform logic throws immediately:

```javascript
// photos-sync-worker.cjs, inside executeTransfer
if (eventType.includes("transform")) {
  throw new Error(`transform_not_implemented:${transformName}`);
}
```

This means **background removal is currently broken** — the old client-side code was removed, and the new server-side code doesn't exist yet. The `gemini-client.ts` even comments: "In a full implementation, we would dispatch a `photos/image_transform_requested` sync event here and wait for completion. For now, we continue with the original image."

**Impact:** Any listing creation workflow that previously relied on background removal now silently skips it. Images will remain unprocessed.

### 2. Client-Side Derivation Keys Use Unstable IDs for Direct Uploads

For direct file uploads (drag-and-drop image replacement), the derivation key uses the *filename* as the source ID:

```typescript
// listing-detail/+page.svelte
const filename = `replace_${uploadKey}_${Date.now()}.jpg`;
generateDerivationKey("ext", filename, "identity")
```

Since the filename includes `Date.now()`, every upload generates a unique derivation key, defeating idempotency entirely. The same issue exists in `photo-history/+page.svelte` and `photos/+page.svelte`. These uploads will never match an existing file.

This is arguably intentional (user explicitly replacing an image should create a new file), but it contradicts the design goal of preventing "redundant copies" from `ext` sources. The design says the source ID for `ext` should be "a stable hash of the canonical URL."

### 3. Duplicate `generateDerivationKey` Implementations

The function is duplicated between:
- `src/lib/google-drive.ts` (TypeScript, typed parameters)
- `functions/shared/photos-sync-worker.cjs` (CommonJS, untyped)

These two implementations must stay in sync manually. The server version does `String(id || "")` while the client does a bare `.replace()` — if `id` is `undefined`, the client will throw while the server will produce `"undefined"`. This is a latent bug.

A shared module or at minimum a shared test asserting parity would reduce drift risk.

### 4. Duplicate `findFileByDerivationKey` Implementations

Similarly duplicated between client (`google-drive.ts`) and server (`photos-sync-worker.cjs`). The server version uses the worker's `driveRequestJson` wrapper with API call logging. The client version uses raw `fetch` and calls `escapeDriveQueryValue`. Both construct queries correctly but via different code paths.

### 5. SQL Injection Analog in Drive Query

The server-side `findFileByDerivationKey` escapes single quotes in the derivation key:

```javascript
derivationKey.replace(/'/g, "\\'")
```

The client-side version delegates to `escapeDriveQueryValue()`, which (per `google-drive.ts:132`) likely does a more thorough escaping. The server's manual escaping is less robust. If a derivation key ever contains a backslash followed by a quote, the server escaping would be incorrect.

### 6. No Integration Tests Written

**Design says (Section 4.1):** Write integration tests for duplicate transfer and duplicate transform scenarios.

**Reality:** No new test files were created. The only test changes are adding `derivationKey` parameters to existing live tests, which is necessary but doesn't verify idempotency behavior. The "Duplicate Transfer" and "Duplicate Transform" test cases specified in the design are absent.

### 7. E2E Test Timeout Bump

`e2e/014-photos/sync-rejection.spec.ts` bumped a timeout from 15s to 30s. This is suspicious — the design doesn't explain why sync rejection would take longer. Possibly the extra `findFileByDerivationKey` API call in the worker adds latency, but doubling a timeout is a code smell per the project's E2E guidelines ("Short, explicit timeouts — long timeouts mask bugs").

### 8. `uploadCSVToDrive` Callers Not Updated

`uploadCSVToDrive` now accepts an optional `derivationKey`, but no callers were updated to pass one. This is inconsistent — either CSV uploads should be tracked (pass a key) or the parameter shouldn't have been added.

### 9. Missing `extractTransferParams` Update

The diff shows `extractTransferParams` now returns `payload`:

```javascript
const { sourceBaseUrl, filename, mimeType, targetFolderId, photoId, payload } = extractTransferParams(requestData);
```

But the diff doesn't show the `extractTransferParams` function being updated. Either the function already returned `payload` (and it was unused before), or this destructuring silently produces `undefined`. If `payload` is `undefined`, then `payload?.transform` and `payload?.sourceType` both resolve to `undefined`, and the worker falls back to heuristics. This works but is fragile.

---

## Design Conformance Matrix

| Design Step | Status | Notes |
|---|---|---|
| Step 1: `generateDerivationKey` | Done | Duplicated across client/server |
| Step 1: `findFileByDerivationKey` | Done | Duplicated across client/server |
| Step 1: `uploadImageToDrive` requires key | Done | All callers updated |
| Step 2: Server "Search Before Work" | Done | Correct implementation |
| Step 2: Server transform handling | Stubbed | Throws `transform_not_implemented` |
| Step 3: Gemini client uses sync queue | Partial | Old code removed; new dispatch not wired |
| Step 4: Redux state convergence | Not changed | Existing reducers relied upon (reasonable) |
| Section 4.1: Integration tests | Missing | No idempotency-specific tests |
| Section 5: Clean Slate note | N/A | Deployment concern, not code |

---

## Recommendations

1. **Implement backend transforms** — This is the critical gap. Without it, background removal is silently disabled. At minimum, add a `remove_bg` handler in the worker, or restore client-side processing as a temporary fallback.

2. **Add idempotency integration tests** — The design explicitly calls for "Duplicate Transfer" and "Duplicate Transform" test cases. These are essential to prove the system works.

3. **Extract shared derivation key logic** — Move `generateDerivationKey` into a shared module importable by both client and server to prevent drift.

4. **Fix unstable derivation keys for direct uploads** — Either use a content hash or accept that direct uploads are intentionally non-idempotent and document this as a known deviation.

5. **Investigate the timeout bump** — Determine if the 15s→30s change in `sync-rejection.spec.ts` is masking a performance regression from the additional Drive API call.

6. **Harden server-side query escaping** — Use the same `escapeDriveQueryValue` utility on the server, or at least match the escaping logic.
