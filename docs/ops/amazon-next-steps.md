# Amazon listing and offer next steps

Status as of October 26, 2026. Scope: Amazon UK, GBP and merchant fulfillment. The current implementation supports reviewed publication; deployment and live outcomes must be verified separately.

## Current capabilities

| Workflow                           | Implemented                                                                                                                                 | Remaining                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Create amifa catalogue products    | Standalone creation with a distinct JAN, local product content and images, chosen product type, validation preview and explicit publication | Shared-JAN children, variation families, richer required-attribute forms              |
| Maintain existing amifa listings   | Compare and publish changed GBP prices and merchant-fulfilled quantities, including stock-only updates to zero                              | Title, description, bullets, images and relationship updates                          |
| Supply existing catalogue products | Inventory JAN scan, candidate ASIN review with photos, exact variant and pack confirmation, offer-only validation and publication           | Live end-to-end verification of the newly added workflow and broader browser coverage |

All manufacturers now appear in the comparison. This does not establish permission to create new catalogue products for every manufacturer. Brand ownership and existing-ASIN offer eligibility need separate controls.

The worker processes up to 100 products per request, isolates failures, expires validation after 30 minutes and compares fresh Amazon state before publication. Accepted or uncertain submissions queue readback; uncertain writes are not automatically resubmitted. “In sync” currently describes supported price and stock fields only.

## First verify the current release

1. Record the deployed Hosting revision, Firestore rules and Amazon functions for the intended Firebase environment. Confirm the seller, marketplace and environment before live requests. Deploy scan functions and their rules together with the UI when releasing the scanner.
2. Verify a seller catalogue refresh and a small inventory scan. Close and reopen the browser, confirm server progress resumes, and exercise cached matches, verified negatives and a failed lookup. Keep incomplete catalogue coverage visible; the seller search stops at Amazon's 1,000-SKU search limit.
3. Add browser coverage for offer review, changing an ASIN clearing confirmation, incomplete rows remaining unsubmitted, reload recovery, validation expiry and stock-only zero updates. Exercise scanner permissions and request validation against the Firestore emulator.
4. Use a reviewed existing-ASIN offer as the first live canary. Record the exact ASIN, variant, pack size, SKU, GBP price and stock; validate, publish once, then verify actual price, quantity, issues and buyability through readback. Separately verify a supported new amifa product and a stock-only zero update.

Acceptance: queued work survives navigation/restart; only confirmed offers publish; repeated triggers do not duplicate writes; submitted targets are observed or the row remains visibly unresolved. A successful preview or ACCEPTED response alone is insufficient.

See [offer preparation](amazon-add-offers.md) and [inventory scanning](amazon-inventory-asin-scan.md) for current operator steps.

## Complete amifa product content synchronization

Define the fields we own on amifa ASINs and the fields Amazon controls. Start with title, description, bullets and images. Show the observed and proposed values, then publish only changed, explicitly owned attributes. Preserve unrelated offer, compliance and catalogue attributes. Normalize Amazon's returned values and image URLs so a successful contribution does not generate endless differences.

Make new catalogue creation explicitly eligible for amifa; other manufacturers should default to verified existing-ASIN offers. Require a recent successful catalogue lookup before choosing creation, while retaining exact match review where candidates exist. The current creation path does not require proof of a completed JAN search.

Add product-type-specific forms driven by the required attributes and Amazon validation feedback. Do not invent safety declarations, pack counts or exemption approval. Retain unsupported products under needs attention without blocking eligible neighbours.

Acceptance: a change to an owned local amifa field produces a reviewable delta, validates and publishes, and settles after readback without overwriting unrelated data. Resolve the [photo import defect](../../PHOTO_IMPORT_BUG.md) before bulk publishing affected images; use verified originals for canaries.

## Resolve shared JAN products

Inventory affected families and establish the identifier strategy for each: verified existing child ASIN, a distinct manufacturer identifier, or documented applicable exemption. Store approval evidence with exact brand, marketplace, category/scope, case and review date. Brand ownership alone must not imply identifier exemption.

Discover supported variation themes by product type. Prepare and validate parent/child relationships only after identity is established. The historical failed children show that setting an exemption flag alone is insufficient; accepted initial submissions did not create those child ASINs.

Acceptance: a small representative family has correct child identities, relationships and eventual sellable offers. Keep existing verified-ASIN offer publication available while family creation remains unresolved.

## Add orders before unattended stock publication

Implement Amazon order ingestion, reservation, cancellation and duplicate handling against the shared inventory model. Define allocatable stock, order freshness and the environment that owns writes. Test cross-channel sales and races between preview, order arrival and publication. Keep operator-reviewed stock publication until those prerequisites pass.

Then add continuous reconciliation, write controls and queue cancellation. Already queued publication currently has no operator cancellation workflow. Monitor queue age, throttling, validation failures, order lag and accepted-to-verified latency.

## Reference implementation

- [Preparation and payload projection](../../src/lib/amazon-preparation.ts)
- [Validation and publication worker](../../functions/shared/amazon-preparation-worker.cjs)
- [Inventory scan worker](../../functions/shared/amazon-catalog-scan.cjs)
- [Comparison UI](../../src/routes/amazon-listings/+page.svelte)
- [Historical milestones and observations](../../AMAZON_SYNC_COMPLETION.md)

The older setup/design documents describe earlier phases. Use this sequence for ongoing work and the historical completion document for dated evidence.
