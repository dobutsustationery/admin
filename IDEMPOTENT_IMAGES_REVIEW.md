# Review: Idempotent Image Transforms — Third Pass (4a18592)

Review of `4a18592` ("Full implementation of server-side idempotent transforms (Review Fixes)"), which claims to address all findings from the second review of `892a6cd`.

---

## Scorecard: Second Review Issues

| # | Issue | Addressed? | Verdict |
|---|---|---|---|
| 1 | `image-processor.cjs` broken at runtime (wrong pipeline output) | Yes | `@xenova/transformers` replaced with sharp-only resize+crop. Not real bg removal though. |
| 2 | `escapeDriveQueryValue` imported but not used | **Yes** | Replaced with `buildDerivationKeyQuery()` shared helper. Clean fix. |
| 3 | `findFileByDerivationKey` duplicated client/server | Partially | Both now use `buildDerivationKeyQuery`, but the function itself is still fully duplicated. |
| 4 | Unstable derivation keys (`Date.now()` in filenames) | **Yes** | All direct-upload sites now use `calculateHash(blob)` for content-based keys. |
| 5 | E2E timeout made worse | **Yes** | `test.setTimeout(30000)` removed, poll timeout reverted to 15s. |
| 6 | Tests only check primitives, not end-to-end flow | **Yes** | New worker-level tests with mock Firestore exercise the full "Search Before Work" path. |
| 7 | `processMediaItems` signature change undocumented | **No** | Still no callers, still no docs. |
| 8 | 60-second silent timeout | Partially | `notify()` calls added for progress. Timeout still 60s, still silent on expiry. |
| 9 | `addDoc` instead of deterministic ID | **Yes** | Switched to `setDoc` with `toSyncPhotoRequestDocId`. |
| 10 | Heavy dependencies without resource config | Partially | Memory bumped to 2GiB; `@xenova/transformers` still in `package.json`. |
| 11 | `csv/+page.svelte` unstable key | **Yes** | Now uses `calculateHash`. |

**Summary: 6 fully fixed, 3 partially fixed, 1 not addressed, 1 new issue introduced.**

---

## Detailed Findings

### 1. `@xenova/transformers` Still in `package.json` (Waste / Confusion)

The `image-processor.cjs` no longer imports `@xenova/transformers` — the ML pipeline was entirely replaced with a sharp resize+crop. But `functions/package.json` still lists it as a dependency:

```json
"@xenova/transformers": "^2.17.2",
```

This adds ~50MB to the deployment bundle (the package itself, before any model downloads) for no reason. It should be removed.

### 2. `removeBackground` Is Now a Misnomer — It's a Resize (Behavioral Regression)

The previous client-side implementation used an actual background removal model (RMBG-1.4 via transformers.js in-browser). The new server-side implementation:

```javascript
const processedBuffer = await image
  .resize(1024, 1024, {
    fit: 'contain',
    background: { r: 255, g: 255, b: 255, alpha: 1 }
  })
  .flatten({ background: '#ffffff' })
  .png()
  .toBuffer();
```

This resizes to 1024x1024 with white letterboxing and flattens transparency. It does **not remove backgrounds**. The function is named `removeBackground`, the transform name is `remove_bg`, and the derivation key encodes `remove_bg` — but the operation is "resize to square with white padding."

The comments acknowledge this: "Deterministic background removal (mocked with smart crop + white background for now)." But this creates a derivation key collision problem: if a real `remove_bg` implementation is added later, files processed by the current mock will have the same derivation key as properly processed files. The idempotency system will treat the mock output as the canonical result and never re-process.

This is the opposite of the problem the design was trying to solve — instead of redundant copies, we get incorrect results permanently cached under the correct key.

**Recommendation:** Either use a different transform name (e.g., `resize_square`) for the current behavior, or add a version component to the derivation key (e.g., `photos:id:remove_bg:v1`). Otherwise, when a real model is deployed, every previously-processed image must have its derivation key manually cleared from Drive `appProperties`.

### 3. `removeBackground` Signature Changed — Takes `imageUrl` It Doesn't Use

```javascript
async function removeBackground(imageUrl, originalBuffer) {
```

The `imageUrl` parameter is only used in a log message:
```javascript
console.log(`[ImageProcessor] Processing background for ${imageUrl}...`);
```

It's not used for fetching or processing. The caller in the worker passes `source.usedUrl` as the first argument:
```javascript
bytes = await removeBackground(source.usedUrl, source.bytes);
```

This is a benign but sloppy signature — it suggests the function might fetch from the URL, but it doesn't.

### 4. `findFileByDerivationKey` — Still Fully Duplicated

Both client (`google-drive.ts:592`) and server (`photos-sync-worker.cjs:177`) have independent implementations of `findFileByDerivationKey`. The query construction was unified via `buildDerivationKeyQuery()`, which is good. But the rest of the function logic — HTTP call, response parsing, result mapping — remains duplicated.

The client version:
- Uses `fetch()` directly
- Returns a `DriveFile` (hydrated with `hydrateDriveFiles`)
- Handles 401 with `clearToken()`

The server version:
- Uses `driveRequestJson()` with API call logging
- Returns a plain object with `{ id, name, mimeType, ... publicUrl, apiUrl }`
- No 401 handling

These return different shapes, making behavioral drift between client and server likely. This is acceptable for now given the CJS/ESM boundary, but should be tracked as tech debt.

### 5. `addDoc` Still Imported in `gemini-client.ts`

Line 13 still imports `addDoc`:
```typescript
import { ..., addDoc, ... } from "firebase/firestore";
```

It's no longer used — the code now uses `setDoc`. Dead import. Minor, but it'll trigger lint warnings and confuses readers about which API is being used.

### 6. `setDoc` + `onDocumentCreated` = Silent Failure on Re-Request

The function trigger is `onDocumentCreated` (line 1 of `functions/index.js`), which only fires when a document is **created** — not when it's overwritten. The client uses `setDoc` with a deterministic ID:

```typescript
await setDoc(doc(firestore, SYNC_COLLECTION, syncRequestDocId), { ... });
```

**First call:** Document is created → worker fires → processes → writes completion event → client's `onSnapshot` resolves.

**Second call (same image, function already ran):** `setDoc` overwrites the existing document → `onDocumentCreated` does **not** fire → worker never runs → no new completion event → client's `onSnapshot` waits 60 seconds → silently resolves to `null` → falls back to original image.

The `findFileByDerivationKey` check at the top of the loop *should* catch this case if the first run completed successfully. But there's a race window: if the second `processMediaItems` call happens while the first worker invocation is still in-flight, the Drive file doesn't exist yet, the derivation key lookup returns null, and the `setDoc` overwrites the request — but since the document already exists from the first call, `onDocumentCreated` won't fire again. The first worker invocation will complete, but the second client is listening for a completion event with the same `requestId`, which may or may not match timing-wise.

This is a narrow race, but it exists and the failure mode is a silent 60-second timeout per image.

### 7. 60-Second Timeout Still Hardcoded, Still Silent on Expiry

Progress `notify()` calls were added ("Requesting background removal...", "Waiting for server to process..."), which is an improvement. But when the timeout expires:

```javascript
setTimeout(() => {
  unsubscribe();
  resolve(null);
}, 60000);
```

There's no notification to the user that the timeout occurred. The `null` result silently falls through to the `else` branch which sets `imageStatuses[imgIdx] = "done"` without updating the image URL. For a batch of images, the user sees "Waiting for server to process..." and then nothing — the status silently moves on.

### 8. New Live Test Timeout Bump (Unrelated)

`tests/live/google-drive.test.ts` bumped a test timeout from 15s to 30s:

```diff
-  }, 15000);
+  }, 30000);
```

This is in a `setFilePermissions` test, unrelated to idempotency changes. No explanation for why this test now needs twice as long.

### 9. Integration Tests: Good Coverage, But Mock Fidelity Concern

The new worker-level tests in `idempotency.test.ts` are a significant improvement. They exercise the actual `processRequestEvent` function with a mock Firestore, verifying:
- First transfer creates a file, second resolves idempotently
- First transform processes, second resolves idempotently
- Both return the same `driveFileId`

However, the mock `db` has limitations:
- `collection().doc().create()` always returns `{ created: true }` — it never simulates the "already exists" case that `createIdempotentEvent` relies on for its own idempotency
- The mock doesn't track state between calls, so the "secret lookup" mock in the transform test returns a hardcoded result regardless of the docId queried

These tests prove the Drive-level idempotency works (real Drive API calls), but they don't fully validate the Firestore event-level idempotency. The design's Section 4.1 calls for verifying "both events resolve to the same ID" — the tests do check `result2.summary.driveFileId === driveFileId`, which satisfies this.

### 10. `calculateHash` — Good Addition, One Edge Case

The new `calculateHash` function in `google-drive.ts` uses `crypto.subtle.digest("SHA-256", ...)` which is correct and available in all modern browsers. All direct-upload call sites now use content hashes for derivation keys instead of timestamps. This properly addresses the original unstable-key issue.

**Edge case:** Two different files with identical content will get the same derivation key and the second upload will be silently skipped (resolved to the first file). This is arguably correct behavior for idempotency but could surprise a user who intentionally uploads the same image to different products with different filenames. The design doesn't specify whether content-identity should be per-folder or global.

### 11. Memory Bump to 2GiB — Appropriate but Broad

`functions/index.js` bumped the `syncRequest` function from 512MiB to 2GiB. This is appropriate for sharp image processing, but this function handles *all* sync events (Shopify sync, photo transfers, photo transforms). A simple Shopify sync request now gets a 2GiB function instance.

A more targeted approach would be a separate function for image processing with higher resources, keeping the general sync function lightweight. But given the project's pre-production status, this is acceptable for now.

---

## Updated Design Conformance Matrix

| Design Step | Status | Notes |
|---|---|---|
| Step 1: `generateDerivationKey` | Done | Server uses shared module; client has typed copy |
| Step 1: `findFileByDerivationKey` | Done | Both use `buildDerivationKeyQuery`; function bodies still duplicated |
| Step 1: `uploadImageToDrive` requires key | Done | All callers updated with content hashes |
| Step 2: Server "Search Before Work" | Done | Correctly implemented, escaping fixed |
| Step 2: Server `remove_bg` transform | **Fake** | Resizes to 1024x1024 with white bg — not background removal |
| Step 3: Gemini client dispatches to sync queue | Done | Uses `setDoc` with deterministic IDs |
| Step 4: Redux state convergence | Not changed | Existing reducers relied upon (reasonable) |
| Section 4.1: Duplicate Transfer test | **Done** | Worker-level test with real Drive API |
| Section 4.1: Duplicate Transform test | **Done** | Worker-level test with real Drive API |

---

## Remaining Recommendations (Priority Order)

1. **Remove `@xenova/transformers` from `functions/package.json`** — It's no longer imported anywhere. Dead dependency adding deploy weight.

2. **Rename `remove_bg` or version the derivation key** — The current "remove_bg" transform doesn't remove backgrounds. When a real implementation is added, all previously-processed images will be incorrectly cached. Use `resize_square_v1` or add versioning to the key format.

3. **Remove dead `addDoc` import from `gemini-client.ts`** — One-line cleanup.

4. **Handle the `setDoc` + `onDocumentCreated` race** — Either switch to `onDocumentWritten`, or add logic in the client to detect that the sync request doc already has a result and skip the snapshot listener.

5. **Add user notification on timeout** — When the 60-second timeout expires, `notify()` the user that processing failed/timed out instead of silently moving on.

6. **Revert the live test timeout bump** — `tests/live/google-drive.test.ts:148` doubled from 15s to 30s without explanation. Investigate rather than mask.

7. **Track `findFileByDerivationKey` duplication as tech debt** — The query construction is unified, but the function bodies remain independently implemented with different return shapes.
