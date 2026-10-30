# Amazon listing and offer next steps

Status updated October 30, 2026. Scope: Amazon UK, GBP and merchant fulfillment. The current implementation supports reviewed publication; deployment and live outcomes must be verified separately.

## Current capabilities

| Workflow                           | Implemented                                                                                                                             | Remaining                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Create amifa catalogue products    | Standalone creation and reviewed single-dimension parent/child families, with distinct identifiers or an explicitly confirmed exemption | Live family canary, multidimensional families, existing-child reparenting, richer required-attribute forms |
| Maintain existing amifa listings   | Compare and publish changed GBP prices and merchant-fulfilled quantities, including stock-only updates to zero                          | Title, description, bullets, images and relationship updates                                               |
| Supply existing catalogue products | Inventory JAN scan, candidate ASIN review with photos, exact variant and pack confirmation, offer-only validation and publication       | Live end-to-end verification of the newly added workflow and broader browser coverage                      |

All manufacturers now appear in the comparison. This does not establish permission to create new catalogue products for every manufacturer. Brand ownership and existing-ASIN offer eligibility need separate controls.

The worker processes up to 100 products per request and isolates failures. New Amifa products are created directly after review; existing-ASIN offers and price/stock updates retain preview and publication, with 30-minute validation expiry and fresh Amazon state comparison. Accepted or uncertain submissions queue readback; uncertain writes are not automatically resubmitted. “In sync” currently describes supported price and stock fields only.

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

## Testing Amifa variation families (October 29, 2026)

On **Amazon listings**, search for a product or JAN and expand its product row.
A new Amifa family is shown once, with all variants, local EUR prices and stock
in one table. Choose **Prepare variant family** to edit it inline. There are no
per-variant creation or exclusion buttons in this new-family flow. Set the Amazon
product type, variation type and each child's GBP price in that editor; local EUR
prices are shown alongside them. Shared-JAN families select the approved GTIN
exemption flow by default, and show those child identifiers as **GTIN exempt**.
Zero-stock children can remain in the family. The parent is a grouping SKU and
has no price, stock or GTIN.

For a shared JAN, supply distinct manufacturer child identifiers or explicitly
select the already-approved Amifa GTIN exemption for this product type. An
approval reference or note is optional; the recorded request always identifies
the operator’s explicit exemption selection, brand, product type and marketplace. The form does not establish exemption eligibility. Amazon's
validation and eventual processing can still reject an exemption or unsupported
variation theme. Do not use a parent's ASIN as an existing child product match.

Review the family details and current stock, then choose **Create variant family**.
This stores the choices and exact parent/child request bodies and queues direct
creation on the server. It does not run `VALIDATION_PREVIEW`. The server submits the parent first (or
reuses a matching existing parent without overwriting it), waits for Amazon to
return that parent, and then submits its children. A failed parent prevents child
submission. Uncertain writes are observed rather than automatically repeated.

The form retains device drafts across reloads; checked choices and job results
also live on the server. Each job records the exact entry, request IDs,
parent-job dependency, any legacy validation result, submission result
and observed baseline in `amazonPrepare/job` facts. Shared sync lifecycle events
feed hedgehoggy. Readback expectations include parentage, parent SKU and variation
theme in addition to child price and stock. Accepted submissions remain distinct
from verified relationships and buyability.

Current scope: new child SKUs with a single variation dimension (colour, style,
pattern or size). Existing unrelated seller SKUs are not overwritten or silently
reparented. Product-type-specific missing attributes appear in Amazon validation
feedback. The worker's validation, dependency and readback changes apply to newly
queued jobs; existing cached facts do not need recomputation. **Schema version
remains unchanged; no full replay is required.**

## Catalogue defaults for automated creation (October 30, 2026)

The catalogue owner confirmed that our products require no batteries and have no
applicable dangerous goods regulations. Creation payloads therefore always include
`batteries_required: false` and `supplier_declared_dg_hz_regulation: not_applicable`,
including grouping parents. Sticker children also retain the standard under-three
choking-hazard warning from the shared product projection. These values do not
require per-product re-entry.

The existing count rule extracts the package count from product descriptions or
titles (for example `(22)`), falling back to one. Sticker payloads use this for
`number_of_items` and `unit_count` with type `count`. No separate GBP RRP is currently
recorded, so `list_price` is zero (Amazon's unavailable value); the reviewed GBP
selling price remains in `purchasable_offer`. These generated attributes are stored
in the exact request body on each validation/publication job. Grouping parents
continue to have no offer, price or stock. The standalone and variation preparation
paths must preserve these attributes rather than deleting them.

## Direct creation flow (October 30, 2026)

New Amifa standalone products use **Review and create listing**, followed by
**Create these products** after reviewing the GBP price and current stock. Families
use **Create variant family** after reviewing all children. Both enqueue
`request_amazon_prepare` with `mode: create`, exact `entries`, and
`stockConfirmed: true`. The worker records `directCreate: true`, the originating
`publishRequestId`, exact request/response, submission time, dependency and readback
state in `amazonPrepare/job` events. No invented VALID validation result is stored.
Existing preview and publication jobs remain readable without migration or replay.

The worker reads each target SKU, creates absent products with a direct PUT, and
reuses a matching family parent. It sends children only after the parent is observed.
Existing unrelated SKUs are not overwritten. Accepted submissions queue readback;
uncertain writes are observed rather than resubmitted. The UI shows processing until
Amazon confirms the result. Amazon can still return delayed product errors.

This follows the successful September Kamome API flow. On October 30, Aquarium
JAN `4542804151633` returned 5461 in preview but its direct PUT was ACCEPTED without
immediate issues (`direct-create-aquarium-20261030`). This establishes a difference
in initial responses, not yet successful ASIN creation or buyability.
