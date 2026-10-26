# Add offers to matched Amazon products

On Amazon listings, select **Add offers** and then **Prepare offers for this
category**. To use a subset, select variants and choose **Prepare selected
offers**; to prepare one, expand its family and choose **Prepare offer**.

The preparation panel lists up to 100 variants with our photo beside the Amazon
photo. Variant photos take priority; shared-barcode and listing-gallery fallbacks
are labelled. Missing images are explicit. Amazon main images use the largest
available resolution. A sole barcode match is selected
as a suggestion, not verified automatically. For each offer, verify the exact
ASIN, variant and pack size, confirm the prefilled GBP price, and tick the match
confirmation. Changing the ASIN clears that confirmation. Prices reuse existing overrides and Amazon GBP prices, then the saved pricing
factor. If no active factor exists, the current user's saved legacy draft factor
is reused without applying unrelated draft decisions. Price editing is optional;
only products with no usable price require entry. Stock comes from the current
inventory. Product-type discovery is not required for existing-ASIN
offers.

**Save and check N offers with Amazon** saves and validates only the complete,
eligible rows. Incomplete rows stay in the panel. Validation does not publish.
The batch status section tracks the requests and exposes **Review and publish N
checked offers** once validation passes. Review prices and stock, confirm the
stock check, then publish. Existing worker safeguards, validation expiry and
readback remain in effect. After reopening the page, validated offers are in
**Ready to publish**.
