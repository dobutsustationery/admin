## 2026-10-06: Durable preparation drafts

Opening preparation now resumes a durable draft scoped to the signed-in user, seller and UK marketplace. Prices, product types, inclusion choices, Later/Resume choices, the pricing factor, filter, current tab, panel state and the stock review acknowledgement survive navigation and reloads. Drafts are distinct from applied sync choices.

- **Apply draft choices** commits the draft's raw choices together. It does not call Amazon. Checking and publishing remain explicit subsequent actions and cannot run with unapplied choices or pending draft sync.
- **Discard draft** clears pending choices and resets the draft view. Previously applied choices, validation results and already queued Amazon operations are unaffected.
- `amazonPrepare/draftSaved` records raw draft input and view state. `amazonPrepare/draftApplied` records the explicit commit with its raw choices; `amazonPrepare/draftDiscarded` records abandonment. The reducer computes effective choices and proposals; no derived prices, eligibility or API payloads are stored in draft events.
- Every edit is first journalled synchronously on the device, then appended to broadcast under a stable event ID. The recovery copy remains until both server acknowledgement and replay have happened; a local Firestore echo alone cannot clear it. Failed saves remain visible and retry on reconnect or with **Retry draft sync**. Storage is scoped by Firebase project, user and seller. Successfully synced drafts can also resume on another device.
- Inclusion defaults apply only where no applied choice exists. Temporary unticking and per-row Save buttons have been replaced by draft inclusion choices and the single Apply/Discard boundary. Stock confirmation is retained for exactly the reviewed job IDs and becomes ineffective if the ready set changes.
- Broadcast rules require draft-event ownership to match the authenticated creator. No new functions or API behaviour are needed for this change.

---

## 2026-10-06: Guided preparation and independent publication

The primary action on `/amazon-listings` is now **Prepare Amifa products for Amazon**. The existing catalogue audit remains below it, and the old diagnostic forms remain available as product tools.

1. Prepare in-stock Amifa products. Existing offers keep their observed GBP price unless overridden. For new products, enter explicit GBP prices or an operator-chosen GBP-per-EUR pricing factor. Choose the Amazon product type; per-product discovery offers Amazon's suggestions.
2. **Check products with Amazon** uses Listings Items `VALIDATION_PREVIEW`. Each product has its own durable job. Invalid or incomplete products do not block other products. Shared-JAN creations need verified identity work and are left out; an exemption is never inferred by this flow.
3. **Review and publish** shows the proposed GBP price and quantity, and the previous Amazon price/quantity. Only validated, unchanged products are eligible. Confirm stock includes recent Amazon sales, then publish ready products. The action is limited to 100 products at a time; it is explicit, not a continuous stock writer.
4. **Needs attention / later** retains unresolved products. **Later** persists a decision to leave a product out; **Resume** brings it back. Other products can continue at either stage.

Existing listings receive only price/merchant-fulfilled quantity PATCH operations; single distinct-GTIN products receive a create PUT after the worker confirms the SKU is absent. This does not yet create new shared-barcode variation families. The advanced diagnostic create tool remains separate and retains its historical behaviour.

Durability: `amazonPrepare/decision` and `/policy` store operator inputs. `amazonPrepare/job` records exact external requests/responses and job progress. The reducer derives proposed payloads, prices and eligibility from these inputs, current inventory and scoped Amazon observations. `request_amazon_prepare` requests schedule server-only `amazon_prepare_jobs`. Publishing references previously validated server jobs rather than accepting replacement payloads. Rules prohibit client mutation of requests and access to job/lock documents.

The worker leases each job, isolates failures, checks current Amazon price/stock/identity against the preview baseline, expires previews after 30 minutes and prevents concurrent guided writes for the same SKU. A write whose outcome is unknown is not retried automatically; durable audit readback is scheduled. Accepted submissions also schedule readback, and acceptance is not labelled buyable. A rejected or stale product requires another explicit check. No stock is sent merely by opening the screen or deploying this release.

Remaining work: shared-JAN/exemption and variation-family preparation; richer forms for product-type-specific missing attributes; zero-stock/continuous reconciliation and Amazon order ingestion before unattended increases; cancellation of already queued batches. Those limits do not prevent independent publication of currently supported, validated products.

References: [Amazon validation preview for creation](https://developer-docs.amazon/sp-api/lang-us/docs/preview-errors-before-creating-a-listing), [validation preview for partial updates](https://developer-docs.amazon/sp-api/lang-en_us/docs/preview-errors-before-partially-updating-a-listing).

---

# Amazon Sync Completion

Status: first operational release implemented on 2026-10-06; production deployment authorized in the project conversation. The broader sync milestones below remain a roadmap.

## October 6 release: Amifa audit and durable readback

The main `/amazon-listings` screen now presents Amifa families and variants with search,
status/shared-JAN filtering, selection, last-observed GBP offers and merchant-fulfilled
quantity, explicit SKU mappings, and actionable statuses. Existing probes and manual
listing submissions are retained inside **Diagnostics**. This release does not add
bulk creation, automatic stock publication, GBP price policy, or Amazon order ingestion.

1. **Refresh seller catalogue** reads the configured UK seller's listings, following
   pagination. Coverage is shown explicitly. Amazon's search limit is 1,000 SKUs;
   limited/failed reads are marked incomplete and never imply remote deletion.
2. Exact local inventory identities matching seller SKUs are identified automatically.
   JAN matches are suggestions only. Save a SKU mapping to handle different remote
   identifiers; shared JANs never imply exemption approval or identify a colour.
3. **Refresh selected SKUs** queues up to 100 linked SKUs. The server records raw
   responses and keeps checking processing listings for up to 24 hours, with backoff
   for 429/5xx. Buyable, zero-stock, parent, and blocking-error responses settle checks.
   Already-created listings are not resubmitted. Existing manual creates now enqueue
   follow-up reads after successful submission.
4. Prices/quantities/statuses are observations, not guarantees of current availability.
   No local EUR price is converted or sent by the audit. Search/store placement is not
   inferred from offer buyability.

Durability: `request_amazon_audit` accepts authenticated UK read requests only;
`amazon_audit_jobs` is server-only operational state. The request trigger and scheduled
worker share leased, transactional jobs. Page cursors and chunked raw response events
commit atomically. `amazonAudit/*` broadcast events retain responses, job facts and
operator mappings; the root reducer derives the rows and health, scoped by seller,
marketplace and SKU. Newer observations win even if replay arrival is out of order.
Schema version 24 rebuilds existing browser caches. Large discovery schemas remain in
broadcast; sync logs reference them instead of duplicating an oversized string.

Deployment targets: `amazonAuditRequest`, `amazonAuditReadback`, the four existing
Amazon request functions, Firestore rules, and Hosting. No automatic marketplace
mutation is scheduled. The only scheduled work is reading explicitly queued jobs.
The scheduler has no work until an audit/refresh/create has queued it.

Validation includes reducer and worker tests, transaction recovery, rate limits,
real Firestore emulator rules/worker checks, browser filter/mapping/reload checks,
formatting, Svelte checks, and the full standard unit suite. Production verification
uses a read-only catalogue request and checks resulting raw observations.

The original detailed roadmap follows; historical observations below are dated and
are not a fresh assertion of seller-account or approval state.

Work in this checkout: `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2`.
Baseline: `codex/amazon-listings-delta-design`, commit `21b7e3e`.
This document is the only file added for this survey. Preserve the existing untracked
`docs/investigations/SYNC_SLOWNESS_ISSUE.md`. Do not relocate the checkout.

## 1. Outcome and scope

Complete the existing Amazon prototype into a dependable UK merchant-fulfilled
listing and offer integration. Operators should select eligible products, review
the actual changes, submit once, and see Amazon's eventual outcome without having
to infer it from raw JSON or repeatedly click Create.

Completion includes discovery, identity mapping, validation, controlled listing
creation and updates, asynchronous reconciliation, bulk operations, and the order
ingestion needed to keep shared inventory correct. An early release can deliver
read-only audits and controlled listing operations; automated stock publishing is
not complete until Amazon orders are accounted for.

Initial scope is the existing UK marketplace, `A1F83G8C2ARO7P`, GBP, and
merchant fulfillment. Additional marketplaces, FBA, advertising/Brand Store
management, financial settlement reconciliation, and automated listing deletion
are separate work. Preserve boundaries in the data model so later expansion does
not overwrite UK observations.

## 2. Evidence and current situation

### Repository and environments

- The Amazon branch has four June 28–30 commits beyond the surveyed main branch.
  The GitHub survey on September 10 found no PR for it. Recheck remote divergence
  when implementation begins; do not assume a deployed build equals main.
- SvelteKit/TypeScript UI, Redux reducers, Firestore broadcast event replay,
  Firebase request-triggered workers, and a separate sync event log already exist.
- September 10 production reads found no Amazon events in `broadcast` or `sync`;
  Shopify/Etsy activity continued. This is historical evidence, not a claim that
  today's deployments have been fully audited.
- Staging has executed real Amazon writes. Its Firebase isolation does not isolate
  Amazon: the configured EU endpoint and seller account are live.
- `scripts/prepare-functions-env.js` fills missing AMAZON_* variables from the
  shared `.env.amazon` file for each environment. Environment ownership must be
  explicit before unattended workers are enabled.

### Successful standalone experiment

SKU `4542804151480`, Amifa Kamome Post Origami & Design Paper (36), ASIN
`B0HJDLMQW8`:

- September 10 submissions at about 11:07 and 11:09 Toronto time were ACCEPTED.
- Immediate reads had empty offers/availability and no errors. Seller Central
  displayed “Add missing offer details” despite retaining price and quantity.
- Subsequent reads became BUYABLE and DISCOVERABLE, with GBP 4 and 14 live units.
  The September 11 read confirms this state with no issues.
- UK holiday mode was checked by the user and was off. Marketplace participation
  returned enabled, without suspended listings. No account fault was established.
- The observations support asynchronous processing as the explanation for this
  experiment. We did not continuously observe the exact activation time. Do not
  turn one successful wait into a universal promise that every listing will heal.

### Failed variation experiment

Staging request `tOqaalnpQV3LLa9s6nA1`, September 10 at 11:33 Toronto time:

| Role | SKU | Submitted offer | September 11 observation |
| --- | --- | --- | --- |
| Parent | `P-amifa-kamome-post-letter-set-nku4qc` | None, by design | ASIN `B0HJDF8DWQ`; links both children |
| Blue | `4542804151466Blue` | GBP 4; 9 units | No ASIN; errors 8560 and 13013 |
| Green | `4542804151466Green` | GBP 4; 8 units | No ASIN; errors 8560 and 13013 |

All three initial PUT responses were ACCEPTED. Later child errors identify missing
`externally_assigned_product_identifier` (8560), followed by inability to create
an offer because the product is absent from the catalogue (13013).

The generator intentionally omitted the shared JAN `4542804151466` and set
`supplier_declared_has_product_identifier_exemption: true`. Amazon retained the
flag but did not create the child ASINs. The observed failure establishes that
this payload is insufficient. It does not establish whether approval is absent,
inapplicable, or whether some other exemption requirement is unmet. An issue's
`enforcements.exemption.status` is not by itself a GTIN approval registry.

### Logging failure

Product-type discovery returned a valid 162,605-character schema string. The
generic sync validator rejects strings over 10 KB and emitted `amazon/rejected`.
The worker nevertheless completed discovery. That rejection refers to a log
payload; it must not be presented as Amazon rejecting the listing.

## 3. What exists and what must change

| Area | Existing implementation | Gap |
| --- | --- | --- |
| Amazon API | Helpers and four request triggers in `functions/index.js` | Extract testable adapter/worker; durable execution, throttling and reconciliation |
| CLI | `scripts/amazon-catalog-probe.ts` | Useful read-only diagnostic; share API/normalization logic with backend |
| Replay | `src/lib/amazon-catalog-slice.ts` and root-reducer wiring | SKU indexes lack seller/marketplace scope; shared active request; latest arrival can replace newer evidence |
| Projection | `src/lib/amazon-listing-projection.ts` | Infers exemptions; hardcodes COLOR theme; copies local numeric price into chosen currency; derives quantity as qty minus shipped |
| UI | `/amazon-listings` | Large prototype page, raw editable JSON, stale “read-only v0” wording; creation completion mistaken for marketplace success |
| Events | `src/lib/sync-events.ts`, sync-status integration | Per-request/per-SKU lifecycle and typed failures needed |
| Rules | Four request collection rules | Creator checks exist; backend must validate scope, intent, payload limits and authorized operations |
| Tests | Projection, slice and sync-status unit tests | Worker failure/recovery, delayed outcomes, concurrency, UI and stock integration not proven |
| Existing marketplace patterns | Shopify worker/order logic; Etsy order logic | Reuse event/reconciliation principles, not Shopify's full product/image replacement behavior |

No demonstrated full seller-catalog crawl, scoped PATCH sync, durable delayed
verification, Amazon order ingestion, or automated Amazon stock reconciliation
exists in the reviewed branch. Existing setup/design documents lag the code and
should be updated during implementation.

## 4. Data ownership and identity

Introduce replayable Amazon channel configuration and explicit mappings:

- Account/marketplace configuration: endpoint, marketplace, currency, locale,
  seller identity, selected shipping template, capabilities, write enablement and
  owning Firebase environment. Keep credentials outside broadcast/client state.
- Listing intent: stable local listing identity, channel status (`no_sync`, draft,
  active, paused), product type, permitted variation theme, Amazon-specific facts
  and field ownership. Do not infer Amazon opt-in from Shopify publication.
- Item mapping: local inventory identity, stable seller SKU, optional verified
  ASIN, role, parent SKU and identifier strategy. Preserve existing remote SKUs
  across local handle/subtype renames; never regenerate remote identity silently.
- Identifier strategy: unique manufacturer GTIN, explicitly matched existing
  ASIN, or documented exemption. Missing/ambiguous strategy blocks creation.
- Approval evidence: marketplace, exact brand, approved category/scope, status
  (unknown/pending/approved/rejected), case reference, reviewed date and evidence.
  Store operator-confirmed approval as such, not as an API-proven guarantee.
- Explicit GBP price/price policy. Current UI displays local EUR prices while
  projection defaults to GBP without conversion. Never silently relabel currency.

Admin owns configured intent and allocatable inventory after order reconciliation.
Amazon owns observed ASINs, catalogue contributions, acceptance, issues and live
offer status. External observations must not overwrite local intent. Normalization
must tolerate Amazon's canonical image URLs and catalogue values without endless
write loops. Unowned fields are shown for information, not automatically overwritten.

## 5. Solve shared-barcode eligibility as a parallel workstream

Audit local products by brand, product type, repeated JAN and existing remote
mapping. Show affected counts and representative families; the user's hundreds
of products have not yet been individually audited in this survey.

For Amifa, verify existing approval or obtain an explicit Amazon decision covering
the actual UK brand/category and shared-manufacturer-barcode situation. Standard
GTIN exemption is intended for products without IDs; these packages have IDs
shared across variants. Do not promise eligibility or conceal those barcodes.
Manufacturer documentation explaining assortment-level JANs may support the case.

Amazon's process is in Seller Central → Catalogue → Add Products → appropriate
brand/category → “I don't have a product ID” → exemption application when offered.
Use the real Amifa brand. Approval must match the exact scope; it is not inherently
one application per child SKU. Obtain confirmation of coverage before scaling.

If exempt creation is unavailable, investigate correct existing child ASINs or
manufacturer-provided variant-specific identifiers with Amazon/manufacturer
guidance. Do not assign one shared EAN to distinct colour ASINs, invent identifiers,
or change the brand to Generic as a workaround. Keep blocked families out of bulk
submission while eligible standalone work continues.

Acceptance: one two-child family obtains distinct correct ASINs, correct parent
relationships and the intended child offers. Merely setting the flag, receiving
ACCEPTED, or passing an ASIN restrictions check is not success.

## 6. Observe and reconcile before adding bulk writes

### Separate submission progress from observed health

Per request/SKU, record queued → validating → submitting → accepted/processing →
verified, blocked, retryable failure, or needs investigation. Include attempts,
submission ID, target revision/hash, Amazon request ID, timestamps, next check,
source of each issue and last successful observation. Aggregate partial family
outcomes without hiding successful members.

Observed health is a separate projection: ASIN present, role, relationships,
BUYABLE/DISCOVERABLE, current offer, live availability, issue severity and freshness.
A non-buyable parent is normal. A zero-stock or intentionally paused child may
match intent without being buyable. A sellable child needs the intended offer and
live stock; distinguish submitted `fulfillment_availability` from live
`fulfillmentAvailability`.

Empty immediate reads without blocking errors mean processing, not a failed offer.
Explicit 8560/13013 errors mean blocked, not “wait and retry.” Historical
`complete_listing_write` events mean submission completed; migration must not
reinterpret them as verified activation.

### Durable readback

Implement scheduled due-work reconciliation first, using persisted cursors/jobs
and short invocations rather than sleeping inside a function. Proposed initial
readback cadence: roughly 1, 3, 10, 30 and 60 minutes, then hourly to 24 hours,
subject to rate limits, jitter and load. These are application defaults, not
Amazon SLAs. At the deadline mark needs investigation, retain evidence and stop
automatic resubmission. Continue ordinary audits at a lower frequency.

Use pagination for full seller-listing audits, targeted refresh for changed SKUs,
and explicit sample/full completeness markers. Failed/incomplete crawls must not
mark unseen listings deleted. For catalogues exceeding search limits, partition
reads or use an appropriate report workflow after separately authorizing report
creation. Do not make one JAN lookup per row on every refresh.

Add Amazon EventBridge notifications later for status, issues and MFN quantity
changes; bridge them into the Firebase worker and preserve notification IDs for
deduplication. Notifications accelerate readback, but scheduled reconciliation
remains necessary for missed events. Partition observations by seller/marketplace/
SKU and reject stale replacements using observation revisions/times and stable
tie-breaking. Notification arrival order is not authoritative.

### Replay and raw evidence

Preserve normalized facts in broadcast and raw evidence with stable references.
Keep bounded small JSON responses inline; archive large schema/API bodies in
immutable content-addressed storage with digest, size and version. Backup/export
must include referenced objects and verify digests on restore. Deterministic
replay must use recorded facts/schema versions, never refetch a changing schema.

Redact access tokens, credentials and signed-URL query credentials; preserve
useful request metadata. Do not log entire customer/order payloads into broadly
readable broadcast. Distinguish log-validation failure from Amazon business errors.
Fix schema handling narrowly rather than disabling binary/size validation globally.

## 7. Plan, validate and execute scoped changes

Build desired and observed projections, then a deterministic change plan per
family/SKU. Display exactly which fields change and which SKUs are blocked.
Separate create/match, price, stock, content, images and relationship operations.
No delta means no write. Unchanged images must not be resubmitted during stock or
price updates; the July Shopify investigation demonstrates why this matters.

Use Product Type Definitions keyed by seller, marketplace, product type,
requirements and schema version. Validate conditional requirements and Amazon
schema extensions, not just top-level required names. Determine allowed variation
themes from the actual product type; COLOR is not universal. Require verified
product facts instead of silently inventing material, origin, units or dimensions.

Add `VALIDATION_PREVIEW` as a distinct explicit operation. It can surface errors
without publishing but does not prove eventual approval/buyability. Validate the
server-side reviewed plan, rather than trusting arbitrary client JSON. Expert
overrides, if retained, need the same validation and visible diff.

Use PUT for deliberate creation/full replacement and narrowly scoped PATCH for
owned attribute updates where supported. Record the exact payload/version; after
a timeout reconcile before repeating a write whose outcome is unknown.

Durability requirements:

- Transactionally claim request/SKU work with leases and deterministic job keys.
  Duplicate trigger deliveries must not repeat completed mutations.
- Persist per-SKU checkpoints; resume only unfinished family operations. Resolve
  parent acceptance/processing dependencies before child work when required.
- Serialize conflicting work per account/marketplace/SKU. Detect stale intent at
  execution; supersede/coalesce queued revisions with an audit trail.
- Retry throttling and transient transport/server failures with bounded backoff;
  honor Retry-After and Amazon rate-limit feedback. Validation and approval errors
  require correction, not blind retry.
- Provide pause/cancel for unsent work. Already accepted remote changes are not
  cancelled or rolled back by cancelling the local request.

## 8. Orders and inventory correctness

Before unattended replenishment, implement Amazon order ingestion through the
existing inventory/order event model. Assess the current Orders API
`v2026-01-01`, access roles, fields and migration constraints; do not start a new
integration on legacy v0 by copying an older example.

Persist incremental cursors with overlap and periodic reconciliation. Deduplicate
by seller/marketplace/order/item plus source revision. Process pending reservations,
confirmed orders, cancellations, partial shipments and adjustments exactly once
in effect. Distinguish MFN from FBA. Quarantine unknown SKUs rather than guessing
from a shared JAN. Financial refunds do not necessarily return stock.

Define allocatable stock against the existing inventory/cost ledger; do not assume
`qty - shipped` accounts for all reservations. Amazon automatically reduces live
stock on sales. Publishing stale local quantity can put sold units back on sale.
Require a fresh order reconciliation watermark and a documented policy for
unseen/in-flight orders before publishing increases. A stale watermark pauses
increases and alerts the operator; a safety buffer alone is not a correctness
proof. Test the race where Amazon sells between calculation and publication.

Decide channel allocation/reservation policy before broad rollout across Shopify,
Etsy and Amazon. Preserve inventory value/cost invariants on replay. Start with
manually fulfilled Amazon orders in Seller Central if necessary; shipping-label
automation can follow, but stock reservation and order visibility cannot be omitted
from the claimed completed sync.

## 9. Operator workflow

Replace the prototype's raw-JSON-first experience with:

1. Refresh/Audit: show account, marketplace, observed time and audit coverage.
2. Resolve blockers: group by brand/category exemption, missing facts, ambiguous
   identity, mapping conflicts, permissions or Amazon processing errors.
3. Review changes: select field groups and eligible families; show price currency,
   allocation, child roles and individual blocked reasons.
4. Submit: one reviewed operation with progress per SKU and family.
5. Verify: automatically refresh until the desired state is observed or a clear
   intervention is needed. Show “accepted; Amazon processing” separately from
   “verified” and “blocked.”

Provide direct ASIN links, refresh-by-SKU, and a support bundle with submission IDs,
timestamps and relevant sanitized errors. Explain catalogue restrictions versus
GTIN eligibility. Search/store visibility is separate from an active offer; never
promise keyword ranking or automatic Brand Store placement.

Bulk selection must expose eligible, excluded and blocked counts before submission.
Repeated JANs are grouped for resolution, not submitted hundreds of times. Persist
batch membership/progress so closing the browser does not lose the operation.

## 10. Implementation sequence and acceptance gates

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| M1: truthful observations | Typed Amazon adapter; per-SKU/request replay; schema logging fix; durable readback; honest UI status | Replay acceptance→processing→buyable and acceptance→8560/13013 without premature success; no false schema rejection |
| M2: identity and audit | Stable mappings, channel intent, scoped approvals, full/targeted audit and GBP pricing policy | No cross-market overwrite, inferred exemption or SKU churn after local rename; actionable blocker groups |
| M3: controlled sync | Versioned diffs, schema validation/preview, scoped writes, leases/checkpoints, partial-family recovery | Unchanged rows cause zero writes; duplicate delivery/crash recovery safe; one standalone and one eligible family verified |
| M4: inventory prerequisites | Order ingestion, reservations, SKU mapping, allocation/freshness policy | Replayed order/cancellation/duplicate/race tests preserve stock and valuation; stale local state cannot blindly replenish Amazon |
| M5: operational bulk rollout | Durable batches, notification acceleration, observability, production enablement | Bounded throttled batches, recoverable outages, clear blocked counts, one owning environment and rollback controls |

Recommended first PR: M1. It addresses the exact confusion from September 10 and
provides reliable feedback while the external exemption question proceeds in
parallel. M2 may proceed without that approval. Broad shared-JAN creation cannot.

### Verification strategy

- Add sanitized fixtures from the standalone transition, child errors, parent-only
  success and oversized schema. Keep raw identifiers only where needed; no secrets.
- Unit tests: normalization, revision ordering, role-aware health, projection/diff,
  currency/identity decisions, approved versus unknown exemptions, conditional
  validation and schema/archive round trips.
- Emulator worker/rules tests: duplicate triggers, concurrent requests, expired
  leases, crash after remote acceptance, parent succeeds/child fails, 429/5xx,
  notification reorder, incomplete pagination and observation deadlines.
- UI tests: processing versus rejection, generated-payload staleness, batch preview,
  blocked approval groups, refresh behavior and success without manual reload.
- Regression replay: existing production backup plus tail through rootReducer;
  compare local inventory, orders, listings and cost/valuation totals. Existing
  `scripts/replay-production-backup.ts` has a hardcoded historical path and catches
  replay errors; parameterize it and fail the verification gate on unexpected errors.
- Run targeted tests during implementation, then repository type checks, formatting,
  full unit tests and affected non-live E2E using current package scripts/CI.
  Older prose references Biome while current scripts use Prettier; follow executable
  configuration. Live tests must be explicitly selected because staging reaches
  the real seller account.
- Live canary: record pre-state; validate; submit one approved change; observe
  settlement; repeat audit to demonstrate no additional write. Do not re-create
  today's already-working product just to obtain a green test.

No tests, deploys, imports, notifications, Amazon writes or credential changes were
performed as part of this documentation-only survey.

## 11. Release, operations and remaining decisions

Before live enablement, make the Firebase environment and Amazon account visibly
explicit. Use a default-disabled server-side write switch plus selected-SKU allowlist
for canaries. Give a single environment ownership of unattended writes for each
seller/marketplace; deploying staging must not start a second stock reconciler.
Separate read, order-ingestion and write switches so writes can stop while
observations continue.

Capture a fresh backup using `scripts/transfer-data.js` export mode and, where
appropriate, `scripts/capture-staging-broadcast-after-cutoff.mjs` with an explicit
environment. Include new worker state and raw archives in future backups. Export
is a future rollout step, not something executed during this survey.

Deploy through emulator → staging with explicitly scoped real-account canaries →
production. Require review of the code, migrations, test results and exact live
operation before publishing. Preserve compatibility with old broadcast events and
pending requests. Rollback disables new writes and drains/pauses unsent jobs;
code rollback cannot undo Amazon mutations. Compensating edits require a fresh
reviewed plan, never automatic deletion of the created ASINs/SKUs.

Track queue age, accepted-to-verified latency, overdue processing, 429s, missing
observations, duplicate suppression, blocked families, order lag and stale-stock
publication blocks. Set alert thresholds from measured canary behavior, separate
from Amazon's broad search-visibility guidance.

Decisions needed before their dependent milestones:

- M2: exact Amazon price policy and which listings opt in; applicable GTIN approval
  scope and evidence; stable identity handling for renamed local listings.
- M3: product-type mappings, valid variation themes and field ownership; which
  existing remote SKUs are adopted versus left unmanaged.
- M4: shared-stock allocations/reservations and Amazon order fulfillment workflow.
- M5: write-owning environment, operational owner and notification infrastructure.

## 12. Sources

Repository sources are linked above by path; relevant starting documents are
[Amazon design](docs/design/AMAZON_LISTINGS_DELTA_DESIGN.md),
[setup guide](docs/integrations/AMAZON_SP_API_SETUP.md), and
[Shopify sync investigation](docs/investigations/SYNC_SLOWNESS_ISSUE.md).
Implementation findings come from the baseline code; historical remote observations
come from the September 10 staging/production survey and September 11 read-only
Amazon SKU checks, not from a complete production deployment audit.

Official references checked for this plan:

- [Listings workflow and asynchronous acceptance](https://developer-docs.amazon.com/sp-api/docs/building-listings-management-workflows-guide): accepted submissions need later status/issues verification.
- [Listing status and submitted versus live inventory](https://developer-docs.amazon.com/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management): buyability, discoverability and inventory are distinct.
- [Notification types](https://developer-docs.amazon.com/sp-api/docs/notification-type-values): status, issue and MFN quantity notifications and EventBridge integration.
- [Validation preview release notes](https://developer-docs.amazon.com/sp-api/docs/sp-api-release-notes): VALIDATION_PREVIEW does not persist listing changes.
- [Orders API](https://developer-docs.amazon.com/sp-api/docs/orders-api): current v2026-01-01 and deprecated v0; verify permissions before implementation.
- [Amazon staff exemption application guidance](https://sellercentral.amazon.co.uk/seller-forums/discussions/t/15742ab9-4d24-4cae-ba35-ab4b2de5e97a): Seller Central application flow and eligibility limits.
- [Amazon staff approval matching guidance](https://sellercentral.amazon.co.uk/seller-forums/discussions/t/9836a8b8-7cf2-481d-b8d4-733a57daeb9f): exact brand/category matching and separate approvals for different scope.
- [Amazon staff visibility guidance](https://sellercentral.amazon.co.uk/seller-forums/discussions/t/73b5e84b-85d1-4fea-8127-998c7d3adeb2): hours-to-24-hour visibility guidance, not an activation guarantee or explanation for explicit identifier errors.

Revalidate API versions, schemas and permissions at implementation time. A GTIN
eligibility decision for the actual shared-barcode Amifa products remains external
and unresolved.
