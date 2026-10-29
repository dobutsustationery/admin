# Etsy listing comparison and manual sync

Open `/etsy-listings` from navigation and choose **Refresh from Etsy**. The refresh reads active, inactive, sold-out, draft and expired listings, their photos and complete variation inventories. It does not edit Etsy. Results and progress survive browser closure.

The page groups quantity, price, title, description, unmatched variation, local presence, inactive listing, missing photo and read errors. Counts overlap. One row represents an Etsy listing; expand it to compare each variation. Listings without a match are not automatically created.

Matching uses exact canonical inventory SKUs, including Default-suffix normalization. Unknown, duplicated or ambiguous matches require review. **Save match** records an explicit inventory key for one Etsy product ID. A listing combining several local listing handles supports per-variation quantity and price updates; it does not inherit a guessed title or description.

Choose a category and review the visible or selected changes (maximum 100 listings), or review a single listing. Submission is a separate button. Quantity sync changes only quantities; price sync changes only EUR prices. Content actions update title or plain-text description separately. Photos, activation, variation creation and shipping settings are managed on Etsy. No automatic stock publication is introduced.

Etsy requires the full variation inventory matrix in an inventory PUT. The worker reads the current matrix, preserves unrelated products, prices, disabled flags, property constraints and processing profile IDs, and changes only selected products/fields. A remote change to the edited field since review rejects that listing for another review. Shared quantity/price constraints that cannot represent the desired values are reported instead of flattening the variation structure. Each submitted listing is read back; failures do not stop other listings. Duplicate delivery of one request does not resubmit its writes. An interrupted or uncertain request must be inspected before submitting again.

Local prices are interpreted as EUR, matching the current Etsy shop and inventory pricing. Other Etsy currencies are displayed but not price-synced. Local No Sync listings are excluded from writes. No Sync status does not deactivate Etsy listings.

## Stored data

- `request_etsy_listings/{requestId}`: immutable authenticated intent: `creator`, `mode` (`refresh` or `sync`), `createdAt`; sync additionally stores `field` and `entries`. Inventory entries contain listing ID and targets with Etsy product ID, SKU, local item key, observed quantity/price and desired value. Content entries contain listing ID, observed text and desired text.
- `etsy_listing_catalog/{listingId}`: server-owned latest observation: shop/listing IDs, title, description, state, URL, currency, images, full inventory response, inventory-read error and observation time.
- `etsy_listing_sync/state`: latest full refresh listing IDs, shop/currency, start/completion time, active request and error. The listing-ID set excludes removed listings on subsequent full refreshes.
- `etsy_listing_results/{requestId}`: server-owned request claim, creator/mode, start/finish time, status, completed/total counts and per-listing verified success/error results.
- `etsy_listing_mappings/{listingId}-{productId}`: authenticated operator mapping with inventory key, creator and update time.
- `etsy_order_sync_state/default`: existing server-only OAuth token storage, shared with the order importer. Tokens are refreshed through the existing Etsy helper.

These are observations and explicit request records, not browser-replayed marketplace writes. Refreshing/reloading the page subscribes to stored state. It does not resubmit requests. No application schema version change or full action replay is required.

## Permissions and release

Reading requires Etsy `listings_r`; editing requires `listings_w`. The setup script now requests both. An older authorization may need renewal using `direnv exec . bun scripts/etsy-setup.ts --env production --reauth`; use the approved OAuth callback. Renewed tokens are saved both to the environment file and the existing server token store, preserving the order cursor, so running workers use the new grant immediately. Production/staging setup uses that environment's matching service-account file, or application-default credentials if it is absent. An API permission rejection is shown per listing. There is no need to renew authorization merely to see mismatches if reading already works.

Deploy Firestore rules, `etsyListingRequest`, `shopifySyncRequest`, and Hosting. After deployment, queue one refresh to populate the comparison. Do not run a bulk Etsy write as part of release verification.

## Shopify quantity-only sync

The Shopify listings Quantity category now submits `syncMode: inventory` with only quantity-different variants. The worker resolves the existing product and inventory items, then sets inventory levels. It does not create/update/publish a product, upload/delete photos, or reconcile image assignments. Requests without this mode retain the existing full-listing behavior.
