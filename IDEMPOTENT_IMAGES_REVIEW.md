# Review: Idempotent Image Transforms — Fourth Pass (bb6d7c0)

Review of commits `a60d6fe` + `bb6d7c0` ("Final idempotent image handling: real backend transforms and append-only fixes"), responding to owner feedback that the mock `remove_bg` was unacceptable and that `setDoc` on append-only collections would fail at runtime.

---

## Scorecard: Third Review Issues + Owner Directives

| # | Issue | Addressed? | Verdict |
|---|---|---|---|
| Owner | `remove_bg` must actually work | **Yes** | Real MODNet model restored. Implementation is plausible but has issues (see below). |
| Owner | `setDoc` on append-only collections is forbidden | **Yes** | Both `gemini-client.ts` and `PhotoUploadManager.svelte` switched to `addDoc`. |
| R3-1 | Remove `@xenova/transformers` from package.json | N/A | Correctly kept — it's used again. |
| R3-2 | Rename `remove_bg` or version derivation key | **No** | Still `remove_bg` with no version component. |
| R3-3 | Remove dead `addDoc` import | N/A | `addDoc` is now the active API. But `doc`/`setDoc` imports were removed — good. |
| R3-4 | `setDoc` + `onDocumentCreated` race | **Resolved differently** | Switched to `addDoc`, so every request creates a new doc and triggers the function. |
| R3-5 | Notify user on timeout | **Yes** | `notify("Server timeout processing ...")` added. |
| R3-6 | Revert live test timeout bump | **Yes** | Reverted to 15s. |
| R3-7 | `findFileByDerivationKey` duplication as tech debt | **No** | Not addressed, still duplicated. |

**Summary: Both owner directives addressed. 3 of 7 review items fixed. New issues introduced.**

---

## Detailed Findings

### 1. MODNet Implementation — Plausible but Fragile (Medium Risk)

The `image-processor.cjs` now uses `Xenova/modnet` with `AutoModel` + `AutoProcessor`, which is a real matting model. The approach:

1. Load image → sharp → raw RGB buffer → `RawImage` (3 channels)
2. Process through model → get `output` tensor (shape `[1, 1, H, W]`)
3. Extract mask from `output.data`, scale 0–1 → 0–255, construct `RawImage`
4. Resize mask to original dimensions
5. Apply mask to alpha channel of original image
6. Smart crop transparent borders

This is structurally correct and matches the [Xenova/modnet HuggingFace documentation](https://huggingface.co/Xenova/modnet). However:

**a) Missing `dtype: 'fp32'` option:**
The HuggingFace model card shows:
```javascript
const model = await AutoModel.from_pretrained('Xenova/modnet', { dtype: 'fp32' });
```
The implementation omits this:
```javascript
model = await AutoModel.from_pretrained("Xenova/modnet");
```
Without `dtype: 'fp32'`, `@xenova/transformers` may attempt to load a quantized variant. If no quantized variant exists for this model, it may default to fp32 anyway — but this is undocumented behavior and could break with a library update. Should be explicit.

**b) Manual tensor-to-mask conversion is fragile:**
```javascript
const maskData = output.data;
const mask = await new RawImage(
  new Uint8ClampedArray(maskData.map((v) => v * 255)),
  output.dims[3], output.dims[2], 1,
).resize(img.width, img.height);
```
The canonical approach from the docs is:
```javascript
const mask = await RawImage.fromTensor(output[0].mul(255).to('uint8')).resize(image.width, image.height);
```
The manual approach works because `output.data` is a flat Float32Array and `output.dims` is `[1, 1, H, W]`. But it bypasses the tensor API's built-in batch indexing (`output[0]`), which means if the library ever changes the output shape or adds batch support, the manual code breaks silently. The `maskData.map()` also creates an intermediate Array before wrapping in `Uint8ClampedArray`, which doubles memory usage for large images.

**c) `imageUrl` parameter still unused for processing:**
`removeBackground(imageUrl, originalBuffer)` takes `imageUrl` only for logging. The function could just take a buffer. Minor, but the signature is misleading.

**d) Model download on cold start remains unaddressed:**
The `Xenova/modnet` ONNX model (~25MB for modnet vs ~170MB for RMBG-1.4) will be downloaded to `/tmp` on first Cloud Function invocation. With `concurrency: 10` in `functions/index.js`, multiple concurrent requests could race on model download. The `loadModel()` function caches `model` and `processor` module-level variables, but two concurrent calls before the first completes will both call `AutoModel.from_pretrained` simultaneously. This should be guarded with a promise-based singleton pattern:

```javascript
let loadingPromise = null;
async function loadModel() {
  if (model && processor) return { model, processor };
  if (!loadingPromise) {
    loadingPromise = (async () => { ... })();
  }
  return loadingPromise;
}
```

**e) No test exercises the actual model inference.**
The live test for transforms (`idempotency.test.ts`) uses the worker, which calls `removeBackground`, which calls `loadModel()`. But the test uses `https://www.google.com/images/branding/googlelogo/...` as the source URL — meaning it will actually attempt to download the modnet model, process a real image, and upload the result. This is correct but will be extremely slow (~30-60s for model download + inference) and will fail in CI environments without internet access. There's no timeout configured on the test.

### 2. `addDoc` Fixes the Append-Only Problem — But Creates a New One

Switching from `setDoc` to `addDoc` correctly respects the append-only collection constraint. Every request creates a new document, and `onDocumentCreated` fires reliably.

**New problem: No client-side dedup for `processMediaItems`.**

The old `PhotoUploadManager` had a `getDoc`/`exists()` check before writing (removed in this commit). The new `gemini-client.ts` flow:
1. Check `findFileByDerivationKey` — if found, short-circuit ✓
2. If not found, `addDoc` a new sync request
3. Listen for completion via `onSnapshot`

If the Drive file doesn't exist yet (first call still in-flight, or transform failed and was retried), every call to `processMediaItems` for the same image creates a **new** sync request document. Each triggers a new worker invocation. The worker's "Search Before Work" catches duplicates at the Drive level, so no redundant files are created — but redundant worker invocations still happen, consuming function execution time and API quota.

The design says "the client can remain naive" and the server enforces idempotency, so this is architecturally correct. But for batches of images where `processMediaItems` might be called repeatedly (e.g., user navigates away and back), it could create many unnecessary worker invocations.

### 3. Dead Code: `toSyncPhotoRequestDocId` and `syncRequestDocId`

In `gemini-client.ts`:
- Line 23: `toSyncPhotoRequestDocId()` function defined
- Line 657: `const syncRequestDocId = toSyncPhotoRequestDocId(img.id, "remove_bg")`
- Neither is used anywhere — `addDoc` on line 668 ignores the computed ID

This is vestigial from the `setDoc` approach. Should be removed.

### 4. `PhotoUploadManager.svelte` Lost Its Dedup Guard

The previous version had:
```javascript
const existing = await getDoc(syncRequestRef);
if (existing.exists()) { return; }
```

This was removed along with the `setDoc` migration. Now `uploadItem` always calls `addDoc`, creating a new sync request even if one already exists for the same photo. The `findFileByDerivationKey` pre-check (lines 291–318) catches the case where the **Drive file** already exists, but doesn't catch the case where a sync request was **already dispatched but not yet completed**.

For rapid button clicks or batch retries, this could create multiple concurrent worker invocations for the same photo. The worker handles this correctly via "Search Before Work", but the redundant invocations waste resources.

### 5. `requestId` in `gemini-client.ts` Is Now Non-Unique

```javascript
const requestId = `photo-transform-${img.id}`;
```

This has no timestamp component. With `addDoc`, multiple sync docs can have the same `requestId` field. The `onSnapshot` query:
```javascript
where("requestId", "==", requestId),
where("eventType", "in", ["photos/image_transform_completed", ...]),
```
Will match completion events from **any** worker invocation for this `requestId`. Since all invocations produce the same result (same derivation key → same file), this is functionally correct. But it means stale completion events from previous sessions could satisfy the listener before the current worker even starts.

This is actually a feature — if a previous invocation already completed, the listener resolves immediately without waiting for the new (redundant) worker. So the non-unique `requestId` works as a form of result caching. Acceptable.

### 6. Worker Error Events Now Correctly Typed

```javascript
const failureEventType = eventType.includes("transform")
  ? `${PHOTOS_NS}/image_transform_failed`
  : `${PHOTOS_NS}/image_transfer_failed`;
```

This is a good fix. Previously, transform failures were reported as `image_transfer_failed`, which the client's `onSnapshot` query wouldn't match (it filters for `image_transform_failed`). The client would never learn about the failure and would time out after 60 seconds. Now the event types match correctly.

### 7. Mock Firestore in Tests Now Tracks State

The mock `db` in `idempotency.test.ts` now uses a `createdDocs` Set and simulates `create()` failures (error code 6 for "already exists"). This is a significant improvement in mock fidelity — `createIdempotentEvent` relies on `create()` throwing for dedup, and the mock now reflects that behavior.

### 8. Derivation Key Versioning — Still Unaddressed

If the modnet model is replaced with a better model later (or the processing pipeline changes — different crop margins, different resize, etc.), images processed by today's model will be cached under the same `remove_bg` derivation key. The idempotency system will serve the old result forever.

This was flagged in the third review. The fix is simple: include a version in the transform name, e.g., `remove_bg_v1` or `remove_bg:modnet`. Without this, any model upgrade requires manually clearing `appProperties.derivation_key` from all previously processed files in Drive.

---

## Updated Design Conformance Matrix

| Design Step | Status | Notes |
|---|---|---|
| Step 1: `generateDerivationKey` | Done | Server uses shared module; client has typed copy |
| Step 1: `findFileByDerivationKey` | Done | Query unified via `buildDerivationKeyQuery`; function bodies still duplicated |
| Step 1: `uploadImageToDrive` requires key | Done | All callers use content hashes |
| Step 2: Server "Search Before Work" | Done | Correct |
| Step 2: Server `remove_bg` transform | **Done (real)** | MODNet model, needs `dtype` fix and singleton guard |
| Step 3: Gemini client dispatches to sync queue | Done | Uses `addDoc` (append-only compliant) |
| Step 4: Redux state convergence | Not changed | Existing reducers relied upon (reasonable) |
| Section 4.1: Duplicate Transfer test | Done | Worker-level test with improved mock fidelity |
| Section 4.1: Duplicate Transform test | Done | Worker-level test (will actually run model inference) |

---

## Remaining Issues (Priority Order)

### Must Fix

1. **Add `dtype: 'fp32'` to `AutoModel.from_pretrained`** — The HuggingFace docs explicitly show this option. Without it, behavior depends on which model variants are available, which could change with library updates. One-line fix.

2. **Guard `loadModel()` against concurrent invocations** — With `concurrency: 10`, multiple requests can hit `loadModel()` before the first completes. Use a promise-based singleton to avoid downloading the model multiple times simultaneously.

3. **Remove dead code in `gemini-client.ts`** — `toSyncPhotoRequestDocId` function (line 23) and `syncRequestDocId` variable (line 657) are unused.

### Should Fix

4. **Use `RawImage.fromTensor(output[0].mul(255).to('uint8'))` instead of manual tensor unpacking** — The canonical API is safer, handles batch dimensions correctly, and avoids the intermediate Array allocation from `.map()`.

5. **Version the derivation key for transforms** — Use `remove_bg_v1` or `remove_bg:modnet` instead of bare `remove_bg`. Without versioning, model upgrades are permanently blocked by cached results.

### Nice to Have

6. **Add client-side request dedup** — Both `PhotoUploadManager` and `gemini-client` will create redundant sync requests on retry. The server handles this gracefully, but redundant worker invocations waste resources. A simple `Set<string>` of in-flight request IDs would suffice.

7. **`findFileByDerivationKey` remains duplicated** — Tech debt. Both implementations use `buildDerivationKeyQuery` now, but the HTTP call, response parsing, and error handling remain independent.

Sources:
- [Xenova/modnet Model Card](https://huggingface.co/Xenova/modnet)
- [@xenova/transformers npm](https://www.npmjs.com/package/@xenova/transformers)
