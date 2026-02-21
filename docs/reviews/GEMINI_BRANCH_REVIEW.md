# Gemini Branch Review: `design/listings-creation`

## 1. Overview
This branch implements the **Listings Creation** workflow, a comprehensive feature allowing users to turn inventory items and photos into Shopify listings. It involves complex integrations with Google Photos (Picker API), Google Drive (Uploads), and Gemini AI (Description generation).

## 2. Key Achievements
*   **Full Workflow Implementation:** The end-to-step flow from Photo Selection -> AI Generation -> Batch Editing -> Publishing is implemented.
*   **Architecture Compliance:** The "Facts vs. Intent" principle was successfully enforced for the `import_existing_variants` action, moving complex data derivation to the `rootReducer` and keeping the action payload minimal ("Green" action).
*   **Resumability:** The Redux slice uses Event Sourcing patterns, ensuring the session can be rebuilt from the broadcast log.
*   **Performance:** A critical 413 (Payload Too Large) error in Firestore sync was resolved by refactoring the payload structure.
*   **Authentication Hardening:** Significant work was done to unify Google Drive and Google Photos token management, ensuring the `PhotoUploadManager` and AI clients use the fresh, multi-scope token from the UI session.

## 3. Critical Fixes (Must Retain)
These fixes address specific, hard-to-debug issues encountered during development. **Do not revert these.**

1.  **PPA URL Handling (`SecureImage`, `PhotoUploadManager`):**
    *   Google Photos Picker API (`.../ppa/...`) URLs are **private** and require the `Authorization` header.
    *   **Uploads:** Must use the **raw `baseUrl`** without resizing parameters (e.g., `=w4096`). Modifying the URL often breaks the signature/access control for these specific API URLs.
    *   **Display:** Resizing parameters (`=w400`) *can* be used if the Auth header is present and valid, but fallback to raw URL is safer if issues persist.
    *   **Auth Header:** `SecureImage` and `PhotoUploadManager` must **always** send the `Authorization` header for `googleusercontent.com` URLs (unlike standard public profiles).

2.  **Token Source:**
    *   `src/lib/listing-creation-slice.ts` and `PhotoUploadManager.svelte` must import `getStoredToken` from **`$lib/google-photos`**, NOT `$lib/google-drive`. The latter reads a potentially stale token, whereas the Photos UI refreshes the former.

3.  **Firestore Protection:**
    *   The 900KB payload limit check in `src/lib/redux-firestore.ts` prevents the app from crashing due to oversized actions.

4.  **State Sanitization:**
    *   `src/lib/store.ts` correctly sanitizes `listingCreation.lastCompletedBatchId` before persistence to prevent the "Celebration" animation from replaying on reload.

## 4. Remaining Risks & TODOs

### 4.1 Token Expiry Handling
*   **Risk:** If the OAuth token expires while the user is working (1 hour lifetime), background processes (uploads, AI generation) will fail with 401/403.
*   **Status:** The current implementation clears the token on 401, breaking the UI ("no entry signs").
*   **TODO:** Implement a smoother re-auth flow or "silent refresh" if possible (though Google implicit flow usually requires a prompt). At minimum, the UI should show a clear "Session Expired - Click to Reconnect" overlay instead of broken images.

### 4.2 Cleanup
*   **Unused Props:** `isUploading` was added to `SecureImage` to silence a warning, but logic utilizing it fully might be incomplete or redundant if `PhotoUploadManager` handles status overlays separately.
*   **Debug Logs:** Ensure all `console.log` statements used for debugging Auth headers are removed or converted to debug-level.

### 4.3 Testing
*   **E2E Consistency:** The E2E tests mock auth. Ensure the mock tokens correctly simulate the `drive.file` + `photospicker` scopes to avoid false positives.

## 5. Conclusion
The branch is functionally complete and architecturally sound after the recent refactors. The primary instability source has been **Google OAuth token management** (stale tokens, scope mismatches, and URL signature sensitivity). With the unification of the token source and the strict URL handling rules, the feature is ready for merging.
