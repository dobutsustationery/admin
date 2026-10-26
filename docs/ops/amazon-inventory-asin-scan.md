# Inventory ASIN scan

On `/amazon-listings`, use **Scan inventory for ASINs**. Leave the test limit
blank to scan all eligible barcodes. Optionally enter a date to recheck verified
negative results older than that date. A limit of N searches the next N eligible
barcodes, ignoring cached skips.

Starting takes one snapshot of all distinct valid 13-digit inventory JANs,
with positive stock on hand (quantity minus shipped), regardless of page filters.
**Include zero-stock items** is off by default. Turning it on includes all stock
levels. A shared JAN is included if any variant has positive stock. Excluded
barcodes are not marked as checked and become eligible when restocked. Products added later are
included in the next scan. The browser can close once the request is saved.
The latest run's counts, retries and failures appear on returning to this page.
The global Hedgehoggy banner subscribes directly to the latest server run,
showing progress across pages and after reopening the app. Limited scans show
lookups completed against the limit; full scans show snapshot barcodes reviewed,
including cached skips.

`amazonCatalogScanRequest` initializes the run and starts work;
`amazonCatalogScanWorker` resumes it every minute. Work is saved after each
barcode. Run leases prevent overlapping workers; expired leases recover after
four minutes. Successful API calls are spaced by at least 1.1 seconds.
Failures retry with exponential delays, up to five attempts per barcode, then
appear in the run's failure list and remain eligible for a subsequent scan.

Server-owned collections:

- `amazon_catalog_scans`: snapshot, cursor, counts, lease and latest 100 failures.
- `amazon_catalog_scan_cache`: seller/marketplace/barcode result and checked date.
- `amazon_catalog_scan_control`: active run and historical-cache import marker.
- `request_amazon_catalog_scan`: authenticated start requests and initialization errors.

The first scan imports successful historical JAN probe results. Later scans
reuse the scanner cache. Focused legacy probes do not refresh that cache.
Only a successful response with zero results, an empty item list and no next
page counts as a verified negative. Matched barcodes are skipped on later
scans; candidates still require exact product/variant/pack verification before
an offer can be prepared.

Results use the existing `amazonCatalog/apply_probe_chunk` event and update
normal listing categories. This does not publish offers, prices or inventory,
and introduces no schema bump or action replay.

Validation: `tests/unit/amazon-catalog-scan.test.ts` covers caching, date cutoffs,
limits, concurrent starts/workers, retry exhaustion, lease recovery, and failed
result commits. Deploy the two functions, Firestore rules, and hosting together.
