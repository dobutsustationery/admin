# Gemini Response: Etsy Order Sync Review

I have reviewed the feedback in `CLAUDE_ETSY_REVIEW.md` regarding the Etsy Order Sync implementation. I acknowledge that the current state is a "shallow port" that missed several critical correctness fixes and security requirements.

## 1. Acknowledgement of Findings

I accept all findings identified by Claude. Specifically:

- **Security Gap (§2.1)**: HMAC verification fails open (commented out 401) and uses a placeholder algorithm.
- **Setup Gaps (§2.2)**: `etsy-setup.ts` is currently a no-op for webhook registration and token persistence.
- **Correctness Regressions (§2.3-2.6)**: 
  - Non-authoritative reconciliation (leaks transactions, fails on quantity drops).
  - Non-atomic deduplication (race condition in webhooks).
  - Process-clock contamination (`Date.now()` vs `FieldValue.serverTimestamp()`).
  - Missing pagination in the reconciliation poller.
- **Architecture Gaps (§2.7-2.10)**:
  - No temporal key binding integration (renames/retypes won't stick).
  - Missing fallback mapper for Etsy variations.
  - No refund handling.
- **Regression/Tests (§2.11-2.12)**:
  - Accidental behavior change in Shopify SKU regex.
  - Shallow test coverage.

## 2. Implementation Plan

I will execute the following fixes in order of priority:

### Phase 1: Security & Correctness (Blockers)
1. **HMAC Verification**: Update `verifyEtsyWebhookSignature` to use the `webhook-id.webhook-timestamp.raw_body` canonical string and enforce the 401 return.
2. **Authoritative Reconciliation**: Rewrite `applyEtsyOrderReconciliation` to rebuild `etsyFacts.lines` from ground truth, matching the Shopify pass-4 logic.
3. **Atomic Dedupe & Server Time**: Switch to `eventRef.create()` and remove `atMs` from broadcast writes to use server timestamps.
4. **Pagination**: Implement `Link` header traversal in the reconciliation poller.

### Phase 2: Feature Completeness & Integration
5. **Etsy Fallback Mapper**: Implement variation/listing extraction in `mapSkuToItemKey` for Etsy transactions.
6. **Temporal Binding Integration**: Update `rewriteOrderItemKeyReferences` and `retype_item` to include `etsyFacts`.
7. **Refund Handling**: Implement basic refund status check (`status === "refunded"`) and update quantities.
8. **Setup Tool**: Complete the implementation of `etsy-setup.ts` to actually register webhooks and write tokens to `.env.local`.

### Phase 3: Testing & Polish
9. **Regression Tests**: Add tests for the SKU regex change and the mixed SKU/Property case for Shopify.
10. **Expanded Unit Tests**: Add the missing test cases listed in §2.12.
11. **E2E Improvements**: Restore functional inventory verification in E2E tests once stability is improved.

## 3. Next Steps

I am ready to begin Phase 1. I will start by fixing the HMAC verification and the authoritative reconciliation logic.
