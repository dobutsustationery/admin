# Code Review: Event-Sourced Shopify Sync Overhaul

**Reviewer:** Gemini CLI  
**Date:** February 20, 2026  
**Subject:** Transition to Append-Only Event Log for Shopify Sync

## 1. Overview of Changes

The synchronization logic has been refactored to use a more robust, append-only event-sourcing pattern. Instead of a single "Red" action in the `broadcast` collection, the system now uses a dedicated `shopify_sync` collection to track the lifecycle of a synchronization request through discrete events:
- `sync_requested` (Initial intent)
- `sync_claimed` (Locking/Assignment to a processor)
- `sync_api_call` (Traceability of external interactions)
- `sync_completed` / `sync_failed` (Final state)

## 2. Shared Logic Architecture

The implementation successfully shares code between the **Cloud Function** and **CLI Tools** by placing core logic in `functions/shared/`.

### Key Shared Modules:
- **`shopify-sync-core.cjs`**: Pure Shopify API interaction primitives (upsert, inventory set, status mapping).
- **`shopify-sync-worker.cjs`**: Orchestration logic for claiming and processing a request document.

### Observation: `.cjs` Usage
The use of CommonJS (`.cjs`) in `functions/shared/` is a pragmatic choice to ensure compatibility with the Firebase Functions environment (Node.js) while still being importable by the CLI tools (Bun/Node.js).

## 3. Review Findings

### A. Architectural Strengths
- **Traceability:** The `sync_api_call` events provide a high-fidelity audit trail of exactly what was sent to Shopify and what the response was, without polluting the main `broadcast` log with excessive detail.
- **Idempotency:** The use of `createIdempotentEvent` (using deterministic document IDs like `claim_{requestEventId}`) prevents race conditions where multiple processors (e.g., a function and a CLI worker) might try to handle the same request.
- **Observability:** The new `/sync-status` route provides a clear view of the system's state by reducing the event log into a "Request View" on the fly.

### B. Areas for Improvement / Concerns

#### 1. Payload Redundancy
In `scripts/shopify-sync-request.ts`, the CLI replays the entire `broadcast` state just to build a snapshot of the listing and variants to put into the `sync_requested` event. 
- **Risk:** If the CLI's state replay is slightly different from the function's (e.g., due to local environment differences), the sync might use stale or incorrect data.
- **Recommendation:** Consider if the `sync_requested` event should only contain the *intent* (the handle) and let the processor (Worker/Function) resolve the latest state from Firestore before executing the sync. However, the current "snapshot at request time" approach is valid for "Intent" if we want to ensure we sync what the user *saw* at that moment.

#### 2. Potential Log Bloat
The `shopify_sync` collection will grow quickly. 
- **Recommendation:** Implement a TTL (Time-To-Live) or a cleanup script for old sync events once they are completed/failed, as they are mostly useful for debugging and short-term status tracking.

#### 3. Error Handling in UI
The change in `src/routes/listing-detail/+page.svelte` moves from `broadcast(...)` to `addDoc(collection(firestore, "shopify_sync"), ...)`.
- **Observation:** This is a cleaner separation of concerns. The UI no longer pretends the sync is an immediate "action" but rather a "request" to a separate subsystem.

#### 4. Dependency Management
The Cloud Function `require`s from `./shared/...`. 
- **Note:** Ensure that during deployment, the `shared` directory is correctly bundled or included in the `functions` source package. Standard Firebase deployment usually handles subdirectories within `functions/` correctly.

## 4. Specific Code Observations

- **`functions/index.js`**: Now very slim, acting only as a thin wrapper around the shared worker logic. This is excellent for maintainability.
- **`scripts/shopify-sync.ts`**: Has been turned into a backward-compatibility wrapper that delegates to the new worker/request scripts. This prevents breaking existing workflows during the transition.
- **`src/routes/sync-status/+page.svelte`**: The `foldRequests` function is a classic event-sourcing reducer. It handles out-of-order events reasonably well by sorting by timestamp/ID before processing.

## 5. Conclusion

The transition to a dedicated, event-sourced sync collection is a significant improvement in reliability and observability. The implementation of shared logic is sound and follows the project's architectural principles. 

**Status:** LGTM (Looks Good To Me) with a recommendation to monitor `shopify_sync` collection size and consider a retention policy.
