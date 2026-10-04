# Order lifecycle and receiving

Updated **2026-10-04** after the owner's clarification. Code reviewed: `codex/amazon-listings-delta-design`, commit `9222e170`, in the existing `admin2` checkout.

This document now starts with the intended lifecycle and the **minimum receiving work for the incoming order**. It supersedes the earlier proposal for a broader receiving subsystem. Investigation detail follows as supporting evidence.

The investigation below was read-only against production and staging; its evidence and scripts are outside the repository. The receiving implementation described in §4 was subsequently added for staging testing. No production deployment or receipt posting is part of this work.

## 1. Intended eventual order lifecycle

The central record should be the **supplier order**, followed from preparation through acceptance of the goods. Customs paperwork and receiving are stages of that order, not unrelated imports that the owner must reconcile manually.

| Stage | Owner's task | Eventual system support | Needed now? |
|---|---|---|---|
| Assemble order | Choose products and quantities | Build/save an order and export a Google Sheet to send to the supplier | No; remains outside the app |
| Obtain quote | Receive supplier prices and availability | Attach quote, retain revisions and compare with requested order | No; remains outside the app |
| Finalize and pay | Agree the final order and make payment | Save final lines, payment amount/currency and evidence | Earlier workflow stays external; capture its facts at receiving |
| Shipped | Record dispatch and shipping cost | Save shipment date, packing/shipping documents and shipping cost | Full workflow later; retain these facts when available |
| Customs | Import final order and shipping documents; review/export customs forms | Establish the order in the app and associate its customs report | **Yes: first in-system appearance for now** |
| Receive and inspect | Count goods, check quality, resolve differences and choose their destination | Review the order's lines and record what is accepted | **Yes: new receiving route** |
| Complete receipt | Confirm accepted goods and their costs | Add accepted resale stock to inventory and company-use goods to an asset/acceptance record | **Yes: single explicit completion action** |
| Follow up | Handle shortages, claims, refunds or later arrivals | Preserve exceptions and explicit corrections against the same order | Record differences now; richer workflow later |

**Agreed near-term boundary:** everything before customs may continue outside the inventory system. We do not need to build an order builder, supplier portal, quote negotiations, payment processing, or a general purchasing system to receive this delivery.

The order records what was agreed/shipped; the receipt records what physically arrived, what passed inspection, and what was accepted. Earlier facts are not overwritten to make a short or damaged delivery appear correct. Exporting customs forms does not change stock.

## 2. Minimum design for the current incoming order

### One order, a linked customs report, and a receiving route

Use the current customs source data as the starting point. Give the supplier order a stable ID and link its customs report(s) to that ID. For existing work, associate the surviving report with the order once; abandoned/replacement reports must not become separate receivable orders for the same invoice.

Add an **Open receiving** action on the saved customs report/order. Proposed route:

`/order-receipt?orderId=<stable-order-id>`

This should be a small saved receiving screen, not another CSV import or a requirement to re-enter all products. It reuses the order/shipping source snapshots, classification work and cost parsing already available. The receiving lines come from product/source rows, **not the grouped HS totals on the customs summary**.

A useful minimal order projection is: reference/name, invoice, linked source/report IDs, raw source versions, optional shipment facts, and receipt status (not started / in progress / completed). Keep a stable order identity when its name or customs report changes.

Do not require separate first-class purchasing, warehouse, shipment and publication systems for this first implementation. Multiple-shipment planning and a fuller order dashboard can come later. Retain source-line identity and explicit receipt-operation IDs so later receipts/corrections can be supported safely.

### Receiving screen

At the top, show supplier/order/invoice, document links, expected delivery quantities, receipt date, and progress. Save work as the owner goes so they can leave and resume.

For each product/variant, show:

- Product description, JAN and the exact inventory subtype/identity; source order/shipping rows and carton where available.
- Expected/shipped quantity and its unit. If order and shipping quantities differ, show both.
- Actual quantity received, quantity rejected/damaged, and quantity accepted.
- A simple **Confirm count and quality correct** action: explicitly accepts the expected/shipped quantity, with no rejected goods.
- An **Adjust receipt** action: enter actual received and rejected quantities plus a reason/note; accepted quantity is derived. Physically missing goods are different from goods received but rejected.
- Destination: **Resale inventory** or **Company use / asset**, chosen explicitly for company-use goods. Allow an explicit allocation if one source line has both uses; allocations must sum to accepted quantity.
- For shared JANs, confirm the variant allocation. Never silently choose the first variant or divide colors equally.
- A visible confirmed/unreviewed state. Prefilled expected quantities are not acceptance.

An explicit “confirm selected correct rows” operation may save repetitive work; it must not confirm hidden/unreviewed exceptions. Do not add a complicated review queue if a filter and a clear table suffice.

For a row expected to contain 10 units, if 8 arrive and 1 fails inspection, save the observation “8 received, 1 rejected” and derive **7 accepted, 2 missing**. Only 7 may be posted to an accepted destination.

Block unresolved products/units/allocations, negative or impossible counts, and unacknowledged over-delivery. Goods not on the original order need a deliberate extra-line decision with source/note and cost rather than silently modifying the invoice. Completion with a shortage is allowed after the owner explicitly records its disposition; it is not a claim that the order was fulfilled in full.

### Cost and payment section

Reuse the input concepts and validation from **Order Exceptions**, directly on this screen:

- Actual receipt date.
- Goods value in JPY.
- Invoice/order total in JPY.
- Expected item count for reconciliation.
- Actual paid amount and currency, using the existing EUR/BGN support initially.
- Original invoice cost rows and manual column interpretation only when automatic interpretation needs correction.
- Shipment date, shipping amount and currency, and whether shipping is already included in the invoice total.

Prefill from saved source facts where available, but make the owner confirm missing or ambiguous values. The owner should not have to finish receiving and then find another route to provide the costs.

Keep the full invoice/payment facts unchanged when quantities differ. Reconcile the original invoice rows against goods value; separately calculate the value of accepted quantities using the reviewed unit costs. Do not spread the full goods invoice amount over fewer accepted units just to force equality. Record shortages/damage and any later supplier credit separately.

For the first version, preserve the existing cost basis: reviewed unit cost JPY, and the exchange derived from actual paid EUR / invoice total JPY (with existing BGN conversion where applicable). This is an implementation continuity rule, not a new accounting policy. Shipping must be recorded separately and its inclusion in the invoice made explicit. Do not silently introduce freight capitalization, depreciation, tax treatment, or automatic landed-cost allocation. If an independently paid shipping amount is to change accepted unit values, that requires a separate explicit rule; it is not implied by entering a shipping field.

Require a valid reviewed cost/exchange for every accepted line before completion. If the actual payment uses an unsupported currency or payment structure, stop for a clearly identified extension rather than invent an exchange value.

### Company assets are a real destination, not stock with a label

The current application has no identified company-asset receipt register. The minimum implementation must address this branch rather than sending everything to resale inventory.

For accepted company-use goods, save an order-linked asset/acceptance record with description, quantity/unit, receipt date, source line, reviewed cost basis and note. Those quantities **must not** increase sellable stock, create Shopify availability, or enter resale-stock valuation. A simple section of the completed receipt can serve as the initial asset register; accounting export, fixed-asset categorization and depreciation are later work.

The fact of accepting goods for company use is a user decision. Whether finance ultimately treats them as fixed assets or expenses is outside this route's first implementation.

### Completion is the one stock-changing step

Before **Complete receipt**, show:

- Expected, physically received, accepted and rejected/missing totals.
- Explicit discrepancies and their notes.
- Accepted quantities going to inventory versus company assets.
- The additions and resulting quantities for existing inventory identities.
- New inventory entries to create, with approved identities and required metadata.
- Accepted cost totals and the payment/exchange basis.
- The true receipt date.

Completing saves one durable intent against the reviewed order/source/receipt revision. The reducer validates the whole receipt **before any inventory or asset posting**. It then adds accepted resale quantities to current inventory, preserves existing shipped quantities, creates receipt/cost lots, and projects the accepted company assets separately.

Reloading, double-clicking, repeating the action, or opening a second tab must not post the receipt twice. Wait for persisted-and-replayed acknowledgment before showing completion. A completed receipt is read-only; corrections and later arrivals must be explicit adjustments/supplementary receipts against the same order, not another run of the original positive-quantity import.

Stock must not change while entering counts, confirming a line, entering costs, generating customs forms, or abandoning an uncompleted receipt.

### Events: facts in, calculations in the reducer

Retain the discipline used for customs:

| Persisted facts or intent | Reducer-derived result |
|---|---|
| Raw order/shipping source data and source/version identity | Parsed product lines and expected totals |
| Owner's received/rejected counts, “correct” confirmations, variant and destination choices | Accepted quantities, differences and allocations |
| Receipt date, original cost rows, payment and shipping facts, column choices | Exchange, accepted values and receipt-lot costs |
| Complete-receipt intent with stable receipt ID and reviewed revision | Inventory additions, asset records and completion status |
| Explicit correction/reversal facts with target and reason | Corrected projections and auditable stock/cost effects |

A “correct” confirmation must reference the reviewed source revision so it cannot accept changed quantities later. Persist no calculated totals, normalized business-result tables or precomputed inventory updates as authoritative events. Derived projections can be cached, but must be discardable and rebuildable.

### Minimum implementation sequence

1. **Bring the current customs order into the chosen production workflow safely.** Preserve the staging facts and resolve their inventory dependencies before receiving live stock (see §3). No broad staging-to-production database copy.
2. **Link an order and receiving draft to the customs report.** Reuse raw source data; add the receiving action/route and resumable per-line count/quality/destination decisions.
3. **Embed the existing cost/payment inputs and preview.** Add shipment/shipping-cost facts, and keep the invoice reconciliation separate from accepted quantities.
4. **Implement the one validated, idempotent completion action.** Reuse inventory/cost-ledger machinery, add the minimal company-asset acceptance projection, and prevent legacy import from being an alternative second receipt for this order.
5. **Test the concrete receipt scenarios before production use.** Exact delivery, shortage, damage, shared-JAN variants, mixed stock/assets, unknown costs, duplicate completion, stale review, reload, existing stock with shipped quantities, and correction/replay. Verify that pre-completion work changes no stock.

Do not build the early order lifecycle or automatic marketplace publication as a prerequisite. After receipt, use the existing deliberate Shopify publication/verification process for resale stock; an asset receipt must never be published. Later automation can attach to this order lifecycle.

## 3. Where the current customs work is saved

A fresh read-only query on **2026-10-04** of `broadcast` event types in the `customs/` namespace found:

| Environment | Firebase project | Customs events |
|---|---|---:|
| Staging | `dobutsu-admin-staging` | **33** |
| Production | `dobutsu-admin` | **0** |

Evidence: `../customs-environment-audit-2026-10-04/staging.json`, `production.json`, and `summary.json`. This independent production query confirms that the earlier absence was not merely a tail-window issue.

There are three reports, all named **Kanegen customs summary**, using the August supplier order and shipping documents for invoice **S067690**:

| Report ID | Created UTC | Current saved state |
|---|---|---|
| `a73f3c81-4e22-4e3a-b0eb-68feddaa95a1` | September 13 04:30:16 | Abandoned |
| `b1c051f8-d817-48c7-86dc-dc63f4ccd02d` | September 13 05:08:17 | Abandoned |
| `226cbf6f-3674-4f24-b1fd-a6c039c35cc1` | September 13 19:48:08 | **Active: use this one as the starting point** |

Open [Customs Summary in staging](https://dobutsu-admin-staging.web.app/customs-summary); the default saved list hides the abandoned drafts.

The active report's source snapshots contain **69 products, 911 pieces and ¥238,230 goods value**. The customs-only replay derives **29.450 kg net**; the saved user input is **35.1 kg gross**, with source “Packing List pdf.” It has classification decisions for 45 JANs.

Sources:

- [Final supplier order, Product List tab](https://docs.google.com/spreadsheets/d/1l8r46zX9Xe_MLzBIaee7A5176zPEptYaYl8BILQbJjc/edit).
- [Shipping invoice, 出荷明細書 tab](https://docs.google.com/spreadsheets/d/1OwsUPm6t-4nvRhP6QgMKOaar89eLWo1lPFAj1At8h2A/edit).

An export started at **2026-09-13 19:56:56 UTC**, and the next event records Google's successful workbook-creation response:

[Customs Summary — S067690 — a0a2fff5-3cb4-43a1-88fc-0717b872d04f](https://docs.google.com/spreadsheets/d/18bsbSthj2dFVoUEdQsEPgEXlZ7TqlOG4za4L94imzjo/edit).

**There is no `customs/exportReadback` event.** This proves that a workbook was created, not that all values were successfully written, verified, or subsequently used for submission. I did not read the workbook's present contents or change it. Do not silently regenerate it merely to resolve this uncertainty.

### Carrying this work forward

The previous “zero production customs reports” finding was correct, but incomplete without checking staging. The work was not lost; it lives in staging.

Moving just these 33 events to production is not automatically sufficient. `customs/sourceReceived` captures inventory classification facts from the inventory state at that point in replay. A customs-only replay with empty inventory leaves 24 products without accepted/resolved codes and rejects the export-start projection. This is a limitation of that isolated replay, not proof that the staging user had an invalid preview.

Before any production migration/receipt:

1. Preserve the raw staging events and identify the single active order/report.
2. Confirm the workbook's contents and the active report in its full staging context.
3. Identify and review the source/HS inputs that depend on staging inventory. Carry explicit approved input facts/decisions forward so production can reproduce the report without importing unrelated staging inventory.
4. Link one production supplier order to the original report/invoice/source identity and record the migration provenance. Preserve the original creation/export evidence; do not claim a verified export where none was recorded.
5. Confirm there has been no separate stock entry for this delivery before completing a live receipt.

Any transfer or deployment is a future implementation step, not something performed by this investigation.

## 4. Implemented receiving flow (staging testing)

The receiving implementation is now available at `/order-receipt`, also linked from each active saved customs report as **Open receiving for this order** and from navigation as **Receive Order**.

For the active Kanegen report, open its receiving link, start the saved receipt, confirm correct rows (filter/select/bulk confirmation is supported), and review any different counts or destinations. Save the receipt/payment details and review the acceptance preview. **Complete receipt and post accepted goods** is the only action that adds stock or records company assets.

Implemented safeguards include saved drafts, exact variant allocations, missing/damaged notes, currency/cost reconciliation, stale revision rejection, source refresh that explicitly clears review, completed-receipt immutability, and repeat-completion protection. Stock and asset values are derived from raw sources and operator facts in reducers. Existing shipped quantities are preserved. Existing source-file stock registrations block accidental receiving, and completed receipts block legacy import of that same file identity. A copied/converted file cannot be identified automatically; the operator's prior-entry confirmation remains necessary.

Current scope: whole source pieces matching one inventory selling unit; legacy loose-piece settings automatically become one sellable pack per received unit when available inventory (`qty - shipped`) is exactly zero. The preview lists affected identities, and completion rechecks stock before setting `pieces` to 1. Existing shipped counters and historical events remain unchanged. Nonzero (including negative) stock still requires resolution. EUR/BGN payment and JPY/EUR/BGN shipping fields are available. Shipping is recorded but not allocated into unit costs. The optional cost TSV supports automatic reconciliation or explicit column selection. Company-use acceptances appear in a separate register on the saved receipt and do not enter resale inventory.

The completed receipt is read-only. A dedicated correction/supplementary-receipt interface, new unexpected invoice lines, full purchasing lifecycle, and automatic Shopify publication are not included in this first version. Unexpected products must be reconciled into the source before receiving; do not use a second unrelated import to bypass checks.

No current production or staging delivery was marked received during implementation; browser tests use isolated Firebase emulators and synthetic fixture identities. Before production receiving, resolve the staging-to-production source/classification transfer described above. Existing marketplace sales remain separate from this supplier lifecycle.

## 5. Production investigation: evidence and limits

### Download and checkpoint

The latest durable production backup located was:

`../production-backup-jun-26-trace-4542804151626/firestore-export.json`

Its recorded export start was **2026-06-26 20:02:50.911 UTC**. September investigations are mentioned in the project history, but I could not locate a surviving September event-tail file or checkpoint. I therefore used the latest recoverable event timestamp in each June backup collection, inclusively, rather than guessing the last September boundary.

New evidence is saved in:

`../production-tail-2026-10-04/`

| Artifact | Purpose |
|---|---|
| `firestore-export.json` | Raw timestamp-bounded production `broadcast` and `sync` documents |
| `checkpoint.json` | Project, capture boundary, per-collection starting and final timestamps and final document IDs |
| `download.mjs`, `download.log` | Read-only download implementation and progress |
| `analyze.ts`, `replay.log`, `analysis.json` | Local replay, derived investigation results, and errors |

The existing [transfer tool](scripts/transfer-data.js) and [its documentation](docs/tools/DATA_TRANSFER.md) establish the Firebase Admin SDK and `service-account-production.json` read-credential convention. That tool supports full export; its `--append` option is for **imports**, not incremental downloads. For this tail, the external investigation script uses the same SDK and credentials, explicitly requires project `dobutsu-admin`, and only issues reads.

Queries use `timestamp >= previous maximum`, `timestamp <= fixed capture boundary`, ordered by timestamp then document ID, in pages of 1,000. The one overlapping document in each collection is retained in the raw tail and deduplicated by document ID for analysis. No secret collections were downloaded.

Capture boundary: **2026-10-04 12:35:19.614 UTC**.

| Collection | Inclusive starting timestamp UTC | Downloaded | Overlap | New document IDs | Last returned event UTC |
|---|---|---:|---:|---:|---|
| broadcast | 2026-06-26 14:08:35.478 | 3,388 | 1 | 3,387 | 2026-10-04 08:49:55.942 |
| sync | 2026-06-26 13:56:34.762 | 3,816 | 1 | 3,815 | 2026-09-15 20:20:31.232 |

The raw tail is approximately 35.6 MB. These are event logs, not a new full Firestore backup. Timestamp queries do not find documents without timestamps, older-timestamp backfills, old-document edits, or deletions. The June backup plus this tail is therefore a reproducible investigation input, not proof of a fully reconciled database snapshot. A future full export/ID audit should check those cases.

For the next tail, start inclusively at each collection's last timestamp in `checkpoint.json`, retain nanosecond precision, paginate with document ID, deduplicate, and capture a new upper boundary. The saved downloader documents this run's June baseline; update its checkpoint input deliberately before reusing it. Do not use a production import/transfer command.

### What changed since that baseline

Among the **new** broadcast records:

- **No** `orderImport/*` events, `fix_stock_order`, `create_stock_order_receipt`, `update_item`, or `bulk_import_items`.
- Four `liveEventImport/commit_import` events, nine paste events, six event-date changes, and one order cancellation.
- 26 Shopify order-created events, 195 order-updated events, 166 reconciliations, and five Etsy reconciliations. These are event counts, **not distinct customer-order counts**.
- 62 Shopify catalog refresh starts and completions, with 71 data chunks.
- 2,731 Shopify API log events and some product/listing metadata edits.

The new sync tail contains 542 claimed attempts, 526 completion events, 16 failures, and 2,731 API-call logs. The failure messages concern image-download failures. Counts span an interval and are not a complete request-to-result reconciliation. A local order/stock change is not evidence of successful Shopify publication.

### Replay findings

I merged the June broadcast backup with the new tail by document ID and replayed **46,250 events** through the current checkout's root reducer. There were **zero thrown replay errors**.

The resulting projection contains:

- 1,297 inventory entries.
- 139 customer/event orders.
- Six registered supplier stock orders.
- No active supplier import session.
- Zero orders flagged by the current Order Exceptions selector.
- Zero stock-order cost issues returned for those six orders.
- No nonempty Shopify/Etsy exception lists in that projection.
- Zero customs reports in the production broadcast history.

These are results of **current-code replay**, not verification that the production browser serves identical code, nor a physical stock audit. The customs work previously deployed to staging should not be assumed deployed to production.

All 12 supplier import-batch events in the recovered history occurred on **2026-03-02**. They established these six supplier orders:

| Supplier stock order | Recorded receipt date | Import mode |
|---|---|---|
| Kanegan #1 / Order 1 | 2023-08-23 | Zero quantities: historical attribution |
| Amifa #1 / Order 2 | 2024-07-02 | Zero quantities: historical attribution |
| Kanegen #2 / Order 3 | 2024-08-02 | Zero quantities: historical attribution |
| Amifa #2 / Order 4 | 2025-09-25 | Positive quantities: stock addition |
| Kanegan #3 / Order 5 | 2025-10-09 | Positive quantities: stock addition |
| Senshu #1 / Order 6 | 2025-12-03 | Positive quantities: stock addition |

Receipt dates come from saved order metadata, not from the March import timestamps. There is no supplier-stock import in the recovered production history corresponding to the August 2026 customs documents discussed earlier. That does **not** establish whether the goods physically arrived.

Recent sales-import history provides a correction example:

| Commit UTC | Event | Business event date | Effect when committed |
|---|---|---|---|
| July 14 12:20:36 | Sofia ComicCon | July 12 | 404 order lines, 1,184 units |
| September 11 19:24:05 | MishMash Sept 2026 | September 11 | 259 lines, 1,324 units; later canceled |
| September 15 19:12:59 | MishMash Sept 2026 | September 11 | 137 lines, 225 units |
| September 15 19:18:33 | Ellie | September 1 | 12 lines, 15 units |

The first MishMash order was canceled by broadcast `PM8epJfsLp2HnlQ5xYJH`, targeting `live-event:mishmash-sept-2026:cM0EmdX4Xxca2tWAAsh3`. Its current replayed status is Canceled with zero lines/units. The later order is `live-event:mishmash-sept-2026:NcgAlfORVpKz4uf3EzMN`, with 137 lines and 225 units. Do not add the two original commit quantities together. This establishes the recorded correction, not that 225 agrees with the physical sales record.

## 6. Existing flows and implementation reference

| Route / mechanism | Purpose and stock effect | Appropriate use |
|---|---|---|
| `/order-import` — Order Import | Reads supplier CSVs from the configured Drive folder; positive quantities add inventory and receipt lots | Reviewed supplier delivery, or carefully controlled historical attribution |
| `/scanner` | `update_item` saves quantity as an absolute snapshot; if quantity is supplied without shipped, shipped resets to zero | Deliberate count/recount, not “add the box I just unpacked” |
| `/inventory` | Direct item/quantity/metadata edits | Corrections with an understood reason; not the default receiving path |
| `/order-exceptions` | Receipt dates, supplier/payment values, invoice cost reconciliation, scanner audit, some receipt repair actions | Complete or repair a registered supplier order |
| `/unpriced`, `/cost-ledger-editor`, `/itemhistory`, `/inventory-value` | Cost/receipt diagnostics, explicit repairs, history and valuation | Investigate discrepancies; not routine intake |
| `/customs-summary` | Reads order + shipping Sheets, reviews classifications, computes/export paperwork; does not add stock | Shipment/customs preparation; separate from receipt confirmation |
| `/photos`, `/listings/create` | Photo processing and listing proposals; approval can split inventory into variants | Product enrichment and deliberate variant allocation |
| `/shopify-import` | Imports a Shopify catalog CSV, inventory/listing metadata and optional quantity reconciliation | Catalog migration/reconciliation, not supplier receiving or customer-order import |
| `/orders`, `/order?orderId=…` | Customer/event orders, packing quantities, corrections and cancellation | Sales/fulfillment; not inbound supplier stock |
| `/live-event-import` | Imports sold quantities, creates a customer/event order and applies outgoing quantities | Market/fair/manual sales |
| Shopify/Etsy webhooks + scheduled reconciliation | Imports/reconciles marketplace customer orders | Normal marketplace sales intake |
| `/shopify-listings`, `/sync-status` | Compares admin listings against Shopify and queues/observes outbound sync | Explicit publication and verification after local changes |
| `/csv` | Exports inventory CSV to Drive | Reporting/export; not a receiving importer |

There is no implemented `/received-inventory` route. Some older design documents describe one, or describe native Sheets support for Order Import, but current code differs. Treat designs as historical intent and the source below as the implementation evidence.

### Supplier CSV import in detail

Sources: [page](src/routes/order-import/+page.svelte), [slice and batch computation](src/lib/order-import-slice.ts), [root orchestration](src/lib/root-reducer.ts), [inventory application](src/lib/inventory.ts).

1. Connect Google and select a **CSV** in the configured Drive folder. The list filters to CSV MIME type/extension; downloading uses Drive `alt=media`. This page does not directly read a native Google Sheet or parse XLSX.
2. **Analyze File** starts/replaces the shared active session and broadcasts raw CSV chunks.
3. The reducer parses the CSV. The UI shows matches, new items, conflicts, resolved rows, completed rows and skipped rows.
4. Resolve conflicting HS code, weight or country of origin by choosing incoming/existing values.
5. A JAN matching multiple variants requires allocation. The UI checks the sum against incoming quantity. New JANs initially create inventory entries; they are not automatically a complete listing.
6. **Process Matches**, **ADD to inventory**, and **Process Resolved** each emit an import intent. The root reducer computes updates, registers the supplier order using the Drive file ID, applies stock/cost effects, and marks rows processed.
7. The page automatically finishes/clears the session when all rows are done or skipped.

Important details:

- The raw header must be the actual CSV header, not a supplier title/preamble. Missing JANs become skipped/error rows. The default view hides done and skipped rows.
- Quantity is inferred from headers such as `qty`, `total pcs`, and order quantity. Selection depends on the file's headers/column order; there is no receiving-specific column-mapping screen.
- The quantity parser uses `parseInt`; malformed, fractional, or thousands-separated quantities need explicit checking rather than assuming robust validation.
- [Cost parsing](src/lib/stock-order-cost.ts) prefers an explicit unit price; otherwise it divides a JPY line amount by a piece quantity. Supplier UNIT/pack count is not the same as PCS.
- Positive import quantity is an **addition** to existing stock, preserving shipped quantities. It is not an absolute available count.
- Zero quantity has special historical handling, including original ordered quantity inference and assignment of costs to prior receipts. Zero does not mean “start a normal receipt and scan the rest later.”
- Processed-row flags protect repeated processing **within the same session**. Restarting analysis clears those flags. A file ID registers the order but is not a durable “this shipment has already been received” lock. A new event ID can add stock again.
- The session is shared application state, not a per-user workspace; import actions largely lack explicit report/session identity. Two operators or browser tabs can interfere.
- Many page broadcasts are not awaited. “Processed” feedback is not a reliable persisted/replayed receipt acknowledgment.
- Ignoring a row marks it processed; completion can include skipped rows. “Session finished” is not a supplier-shortage reconciliation.
- Analysis, conflict decisions, and batch effects are largely replayable already. That foundation should be retained.

### Scanner and stock counts

Sources: [scanner](src/lib/InventoryScanner.svelte), `applyInventoryUpdate` in [inventory](src/lib/inventory.ts).

A scan identifies a product and proposes metadata. Save emits `update_item` with a quantity. For an existing item the reducer treats this as a **snapshot**, and the scanner does not send the old shipped value. This can reset the shipped counter and reconcile the cost ledger around the new available count.

The scanner also initially defaults quantity to **10**. It does not require a supplier order, receipt ID, carton or physical delivery date.

Therefore, entering “10 arrived” after a supplier import is not a harmless confirmation. A count snapshot must mean the intended total physically available stock, including existing stock, and needs a separate stocktake procedure. Variant choice must also be deliberate; barcode alone is not enough when several variants share a JAN.

### Cost and receipt repair

Sources: [Order Exceptions](src/routes/order-exceptions/+page.svelte), [selectors and previews](src/lib/order-exceptions.ts), [Unpriced](src/routes/unpriced/+page.svelte), [cost engine](src/lib/cost-engine.ts).

A supplier order can carry receipt date, goods value JPY, invoice/order total JPY, expected piece count, and actual paid amount/currency. Cost rows can be pasted as TSV with automatic or manual column interpretation. The screen previews matches, differences, unpriced lots, origins and weights.

The current calculation derives EUR from the entered payment and derives the JPY→EUR ratio from paid EUR / order total JPY. Goods totals and invoice totals have different purposes; do not substitute one for the other. The receipt/sale ledger derives moving-average cost using business receipt/sale dates.

A single `fix_stock_order` event carries user facts and raw pasted TSV. The reducer derives the results. Caveat: metadata is applied before the cost validation branch, so a stale or rejected cost reconciliation can leave metadata applied even though costs were not. “Atomic fix” in the UI means one event, not strict all-or-nothing validation.

**Create stock-order receipt actually adds stock** and a receipt lot. It is not just a metadata repair. The Unpriced reconstruction tools are specialized historical repairs and must not be used casually to clear warnings.

Order Exceptions' “all complete” covers missing date, money and unpriced-lot flags. It is not a delivered-vs-ordered check, warehouse sign-off, or marketplace-sync guarantee. Its scanner audit infers a likely historical scan batch for zeroed imports; it does not establish an authoritative shipment-to-scan link.

### Sales imports and marketplace sync

Sources: [live-event page](src/routes/live-event-import/+page.svelte), [live-event reducer](src/lib/live-event-import-slice.ts), [customer order page](src/routes/order/+page.svelte), [functions](functions/index.js), [Shopify sync page](src/routes/shopify-listings/+page.svelte).

Live-event paste parsing infers the event name, selects a sold-quantity column, and initially approves valid rows. Review the sold column, event date, exact variant match, and oversold warnings before committing. Commit creates an event order and applies `package_item` effects. Processed rows guard the current paste; pasting again resets row state, and the new commit gets a new order identity. Re-importing a complete corrected sales sheet without reversing the previous order can double-count.

Shopify and Etsy have webhook handlers and reconciliation schedules defined as every 15 minutes. Their customer-order events must not be counted again through Live Event Import or packing controls. Schedule configuration in source is not a guarantee of current scheduler health; this investigation did not inspect deployment configuration.

Customer-order barcode packing increases the packed quantity; it is not a separate “confirmed shipped without changing stock” check. Use it only when the operation really is an additional outgoing quantity.

Outbound Shopify listing publication is a separate request path. The live-event and supplier import reducers do not enqueue listing sync themselves. The Shopify Listings page explicitly writes requests to `request_shopify_sync`; inspect completion and refresh the catalog to verify resulting quantities. The code still queues full listing projections, and the recovered sync failures concern images—quantity correction can therefore be delayed or blocked by unrelated listing work.

The [Shopify import reducer](src/lib/shopify-import-slice.ts) can reconcile local quantities toward catalog quantities unless quantity import is ignored. Do not use a stale Shopify CSV as a substitute for physical receiving.

