# Design: Idempotent Image Transforms & Durable Registry

## 1. Problem Statement

Currently, image transfers and transformations create redundant files in Google Drive:
- **Redundant Transfers**: Promoting a photo from Google Photos or Shopify creates a new file every time.
- **Redundant Transformations**: Operations like "Remove Background" create a new successor file on every execution.
- **Quota Waste**: These redundant copies consume storage and API quota needlessly.

## 2. Intended Design: Unified Transform Model

We will unify all image creation (copies and edits) into a single deterministic "Transform" model. Every image in our Google Drive "Registry" is the output of a transform applied to a source.

### 2.1 The Derivation Key
Every image file created by the application in Google Drive will be tagged with a `properties.derivation_key` that uniquely identifies the *intent* that created it. (We use `properties` rather than `appProperties` for access-control reasons — `properties` are visible across apps and in the Drive UI, which is needed for cross-service queries.)

**Key Format**: `{source_type}:{source_id}:{transform_name}`

- **Identity Transform** (Copying an original):
  - Source Type: `photos` (Google Photos) or `ext` (External URL)
  - Source ID: `mediaItem.id` or a stable hash of the canonical URL.
  - Transform Name: `identity`
  - *Example*: `photos:XYZ123:identity`
- **Image Edits** (Transforming a Drive file):
  - Source Type: `drive`
  - Source ID: `driveFileId` of the original Drive copy.
  - Transform Name: `remove_bg`, `crop`, etc.
  - *Example*: `drive:ABC789:remove_bg`

### 2.2 Server-Side Idempotency (The Primary Enforcer)
The backend `sync` worker is the source of truth for idempotency.
- The client dispatches a `sync` request (e.g., `photos/image_transfer_requested` or `photos/image_transform_requested`).
- The server worker receives the request and calculates the expected `derivation_key`.
- **Search Before Work**: The worker searches Google Drive for any file matching that `derivation_key`.
- **Resolution**:
  - **If found**: The worker immediately emits a `completed` event with the existing `fileId`, without performing any download or upload.
  - **If not found**: The worker performs the work (transfer or transform), uploads the file with the `derivation_key` set in `properties`, and emits the `completed` event.

This ensures the client can remain "naive"—it always requests the work it needs, and the server ensures that work is only done once.

## 3. Implementation Plan

### Step 1: Update `src/lib/google-drive.ts`
- **Add `findFileByDerivationKey(key)`**: Helper to search for files in the configured folder tree using the `properties` query: `properties has { key='derivation_key' and value='...' }`.
- **Update `uploadImageToDrive`**:
  - Require `derivationKey` as a mandatory parameter to prevent untracked uploads.
  - Include it in the `properties` metadata during upload.
- **Expose `generateDerivationKey(type, id, transform)`**: Utility to ensure consistent key generation across client and server.

### Step 2: Backend Worker Idempotency (`functions/shared/photos-worker.cjs`)
- Implement the "Search Before Work" logic in the image transfer handler.
- Ensure all uploads from the worker include the `derivation_key`.
- Add support for a new `photos/image_transform_requested` event type to handle idempotent edits. All transformation logic (background removal, cropping, etc.) will be performed by backend workers.

### Step 3: Align Gemini Client (`src/lib/gemini-client.ts`)
- Update the background removal flow to use the `sync` queue instead of performing local processing.
- This allows the transformation to benefit from the same server-side idempotency, logging, and unified transform model as the initial transfer.

### Step 4: Redux State & Registry
- Ensure `photos-slice.ts` reducers (`complete_upload`, etc.) correctly handle the `fileId` and `permanentUrl` returned by the server, regardless of whether the file was newly created or resolved from the registry.
- The `urlHistory` will naturally converge on the canonical Drive URL for a given source.

## 4. Verification Plan

### 4.1 Integration Tests
- **Duplicate Transfer**: Dispatch two `photos/image_transfer_requested` events for the same Google Photos ID. Verify only one Drive file exists and both events resolve to the same ID.
- **Duplicate Transform**: Dispatch two `photos/image_transform_requested` events for the same Drive file and operation. Verify only one "processed" file exists.

## 5. Deployment Note
Since the application is not yet in production, we will perform a "Clean Slate" deployment:
1. Delete all existing files in the application's Google Drive "Images" folder.
2. Deploy the updated worker and client code.
3. The new idempotent registry will populate as users interact with the system.
