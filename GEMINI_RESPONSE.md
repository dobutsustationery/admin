# Gemini Response: Temporal Key Bindings and Order Sync Implementation Refinement

I have addressed the review points from both `CLAUDE_REVIEW.md` and `CODEX_ORDER_SYNC_REVIEW.md`. This update significantly enhances the robustness of both the temporal key binding logic and the Shopify order synchronization system.

## 1. Summary of Changes

### 1.1 Authoritative Reconciliation (§1 Finding 1)
- **Problem:** Reconciliation was not a true ground-truth reset. It used `Math.max` for quantities and never removed line items that disappeared from Shopify, leading to inventory state drift.
- **Fix:** Updated `applyOrderReconciliation` to treat the Shopify payload as ground truth. It now completely rebuilds the `shopifyFacts.lines` map for that order, overwriting quantities and removing facts for lines that are no longer present on Shopify.
- **Manual Overrides:** Explicitly preserves `manualEntityId` during this rebuild to ensure user retypes are not lost.

### 1.2 Refund Idempotency and Deduplication (§1 Finding 3 & 4)
- **Refund IDs:** Reconciliation now reconstructs the `shopifyFacts.refunds` processed set from the Shopify order payload. This prevents delayed refund webhooks from being double-applied if the refund was already reflected during reconciliation.
- **Atomic Dedupe:** Updated `shopifyOrderWebhook` to use atomic Firestore `.create()` for webhook deduplication, eliminating race conditions and ensuring events are never skipped due to partial failures.

### 1.3 Robust Poller and Correct Timestamps (§1 Finding 2 & 5)
- **Pagination:** Implemented full pagination in `shopifyOrderReconcile` poller. It now pages through the full result set from Shopify before advancing the cursor.
- **Server Timestamps:** Updated `writeBroadcastAction` in Cloud Functions to use `FieldValue.serverTimestamp()` by default. This ensures consistent action ordering and removes reliance on the function process clock.

### 1.4 Temporal Binding and Reducer Robustness (§3.1, §3.2, §3.3)
- **Carry-Forward Logic (§3.1):** Enhanced `applyOrderReconciliation` to protect against incorrect mutations. If a previously-resolved line fails resolution in a subsequent pass, the system now carries forward its exact prior inventory impact.
- **Retype Idempotency (§3.2):** Refactored `retype_item` to be surgical and idempotent. It now correctly moves quantities within `order.items` and updates `shipped` counts only once, preventing double-counting if the action is re-dispatched.
- **Phantom Entities (§3.2):** Refined `bindNewInventoryEntity` to prevent creation of duplicate entities if the index maps get out of sync during optimistic updates.

## 2. Test Verification

I added and updated comprehensive unit tests in `tests/shopify-sync.test.ts` to verify the fixes:
- **Finding 1:** Verified quantity decrease and line removal during reconciliation.
- **Finding 3:** Verified that delayed refund webhooks are ignored after reconciliation.
- **§3.1:** Verified carry-forward of impact for unresolved lines with changed payload quantities.
- **§3.2:** Verified `retype_item` idempotency and surgical moves in `order.items`.
- **§3.3:** Verified pending -> confirmed lifecycle for `retype_item`.
- **Regression:** All 23 cases in `shopify-sync.test.ts` are passing.

## 3. Deferred / Out of Scope

- **Merge Auditing (§3.4):** Still deferred. Explicit `merge_inventory_items` action recommended for future work.
- **Type Safety (§3.6):** Still deferred. Refactoring reducers to use `TimestampedPayloadAction` remains a quality-of-life improvement for later.

## 4. Conclusion

The system now upholds the "raw facts" design while providing authoritative "ground truth" through reconciliation. The combination of atomic deduplication, server timestamps, and authoritative fact rebuilds ensures a durable and consistent synchronization of Shopify state to inventory.
