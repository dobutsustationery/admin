# Shopify Sync Implementation Review

**Reviewer:** Gemini CLI  
**Date:** February 20, 2026  
**Subject:** Evaluation of Shopify Sync Architecture (Cloud Functions vs. Browser)

## 1. Summary of Findings

Codex has implemented a robust, event-sourced Shopify synchronization mechanism. The implementation consists of two main components:

1.  **Reactive Cloud Function:** (`functions/index.js`) An `onDocumentCreated` trigger that listens to the `broadcast` collection for `shopify_sync_listing_request` actions and executes the sync.
2.  **CLI Tool:** (`scripts/shopify-sync.ts`) A Bun-based script that can either perform a full inventory diff sync or process the same queued requests as the Cloud Function.

The UI (`src/routes/listing-detail/+page.svelte`) dispatches an intent-based action to Firestore, which is then picked up by one of these processors.

## 2. Why a Cloud Function (or Backend) is Required

The user's intuition that this _could_ be done in the browser is technically understandable for modern web apps, but in the context of the Shopify Admin API, a backend (Cloud Function or CLI) is **the only secure and functional way** for several reasons:

### A. Security (Credential Protection)

The Shopify Admin API requires an `X-Shopify-Access-Token`. This is a **private, long-lived credential** with high privileges (read/write products, inventory, etc.).

- **Browser Risk:** If this token were placed in the Svelte frontend, it would be exposed in the JavaScript source code or network tab. Any user (or malicious script) could extract it and gain full control over the Shopify store.
- **Backend Solution:** Cloud Functions allow the token to be stored securely in Environment Variables or Secret Manager, ensuring it never reaches the end-user's device.

### B. CORS (Cross-Origin Resource Sharing)

Shopify's Admin API **does not support CORS** requests from web browsers.

- Browsers block direct requests from `your-app.com` to `your-store.myshopify.com/admin/api/...` for security reasons.
- A backend (which is not subject to CORS) is required to act as a proxy between the app and the Shopify API.

### C. Reliability & "Facts vs. Intent" Philosophy

The project follows a strict Event Sourcing architecture.

- **Intent:** The browser dispatches a `shopify_sync_listing_request`.
- **Fact:** The Cloud Function logs a `shopify_api_log` (the result of the call) and a `shopify_sync_listing_result`.
  Performing the sync in the browser would bypass this reliable "Fact" generation if the user closed the tab mid-sync, leading to a state mismatch between this system and Shopify.

## 3. Potential Alternatives

While a backend is mandatory, the _type_ of backend could vary:

1.  **SvelteKit Server Routes (`+server.ts`):**
    - If the application used SSR (Server-Side Rendering) and was deployed to a Node.js environment, these routes could handle the Shopify calls.
    - **Why it wasn't used:** The project is structured as a client-side app interacting directly with Firebase. Using Firebase Cloud Functions is more idiomatic for this architecture and avoids maintaining a separate SvelteKit server process.

2.  **Shopify App Proxy:**
    - Shopify allows creating an "App Proxy" that forwards browser requests to a backend.
    - **Why it wasn't used:** It still requires a backend to receive the proxy request and sign it. It adds complexity without removing the need for the Cloud Function.

3.  **Client-side with Public App OAuth:**
    - If the app was a "Public App" distributed on the Shopify App Store, it could use an OAuth flow where the user authorizes the app.
    - **Why it wasn't used:** Even with OAuth, the Access Token must be managed by a backend. Furthermore, this is an internal admin tool using a "Private App" credential, which is simpler and more appropriate for this use case.

## 4. Architectural Critique

- **Code Duplication:** There is significant logic duplication between `functions/index.js` and `scripts/shopify-sync.ts`. The logic for mapping internal listings to Shopify products should ideally be shared in a common library (e.g., in `src/lib/shopify-logic.ts`), although Firebase Functions and local Bun scripts sometimes have different dependency requirements.
- **Trigger Efficiency:** The Cloud Function triggers on _every_ broadcast action. As the system grows, this will become expensive. It would be better to use a specific sub-collection for tasks or a more granular trigger.
- **Resilience:** The current implementation does not include automatic retries for rate-limiting (Shopify has a strict leaky-bucket API limit). A queueing system (like Google Cloud Tasks) would be more robust for high-volume syncing.

## 5. Conclusion

Codex made the **correct architectural decision** by using a Cloud Function. Implementing this directly in the browser would have been impossible due to CORS and a critical security failure due to credential exposure. The current approach aligns perfectly with the project's event-sourcing mandates while maintaining maximum security.
