# Navigation plan: Tools and Obsolete

**Approved for implementation and staging testing on 2026-10-04.** The owner amended the original proposal: make **Tools** a top-level entry and use **Obsolete**, not Archived. This supersedes the contextual-only tool placement and the proposed renaming of Archives.

## Agreed structure

The sidebar has **16 top-level entries**: 14 operational links and two expandable groups, **Tools** and **Obsolete**. All 32 original destinations remain accessible, and Amazon Listings is added. Existing URLs, page behavior, data and reducers remain unchanged.

| Order | Label | Destination |
|---|---|---|
| 1 | Dashboard | `/` |
| 2 | Inventory | `/inventory` |
| 3 | Customer Orders | `/orders` |
| 4 | Customs Summary | `/customs-summary` |
| 5 | Receive Order | `/order-receipt` |
| 6 | Live Event Import | `/live-event-import` |
| 7 | Create Listings | `/listings/create` |
| 8 | Photos | `/photos` |
| 9 | Product Catalog | `/shopify-products` |
| 10 | Shopify Listings | `/shopify-listings` |
| 11 | Amazon Listings | `/amazon-listings` |
| 12 | Inventory Value | `/inventory-value` |
| 13 | Sync Status | `/sync-status` |
| 14 | Account | `/account` |
| 15 | Tools | Expandable group below |
| 16 | Obsolete | Expandable group below |

Label changes: View Inventory → Inventory; Process Orders → Customer Orders; Shopify Products → Product Catalog. Product Catalog edits local product/listing data and exports Shopify-format CSV; Shopify Listings handles catalog comparison and publication. Both remain useful. Amazon Listings previously had no sidebar link despite being an active workflow.

## Tools

These remain supported and directly discoverable from the sidebar, rather than requiring new links scattered through other pages. Existing contextual links remain intact.

| Label | Route |
|---|---|
| Subtypes | `/subtypes` |
| Subtype Exceptions | `/subtype-exceptions` |
| Export CSV | `/csv` |
| Saved Names and Codes | `/names` |
| Item History | `/itemhistory` |
| SKU Review | `/sku-review` |
| Photo History | `/photo-history` |
| Order Exceptions | `/order-exceptions` |
| Cost Issues | `/unpriced` |
| Audit Log | `/audit` |
| DevTools | `/devtools` |

Receiving does not replace historical cost repair. Photo History has editing/retry capabilities, and saved names still support shared input components. These tools are not obsolete merely because they are secondary navigation.

## Obsolete

| Label | Route |
|---|---|
| Supplier CSV Import | `/order-import` |
| Direct Stock Entry / Scanner | `/scanner` |
| Shopify CSV Import | `/shopify-import` |
| Archives | `/archives` |
| Archive-based Event Sales | `/shows` |
| PayPal Payment History | `/payments` |
| Blank-subtype Editor | `/jancodes` |
| Image Edit Testbed | `/test-edit` |

**Archives keeps its name.** It is the existing inventory-snapshot workflow, now under Obsolete; there is no new Archived entry to confuse with it.

Obsolete means displaced from the normal workflow, not deleted, disabled or read-only. Some of these screens can still change stock or sales. Their original behavior and validation remain unchanged. The source review identified the scanner, old payment channel, blank-subtype editing, inventory snapshots and Shopify CSV import as candidates whose actual usage could justify moving them back to Tools later; the owner's approval authorizes the placement above, not a claim that analytics prove them unused.

## Complete inventory and rationale

The following records the original 32 labels and purposes reviewed against [Navigation.svelte](src/lib/components/Navigation.svelte) and the route implementations. Tools placement below refers to the top-level Tools group; any suggested page association describes its purpose, not additional links required in this implementation. Earlier usage questions are retained as context, not pending implementation blockers.

| # | Current label | Route | What it does today | Proposed disposition |
|---|---|---|---|---|
| 1 | Dashboard | `/` | Overview, activity and quick actions. | **Top level**; updated shortcuts. |
| 2 | Create Listings | `/listings/create` | Guided listing creation. | **Top level**. |
| 3 | Add Inventory | `/scanner` | Hosts `InventoryScanner`; scans and directly saves inventory records/counts, without the new supplier receipt review. | **Obsolete:** “Direct stock entry / scanner (legacy)”; routine incoming stock goes through Receive Order. Confirm whether ad-hoc item creation or stocktakes still need a prominent scanner entry. |
| 4 | View Inventory | `/inventory` | Inventory table with editable item fields and old pieces/quantity/shipped presentation. | **Top level:** “Inventory”. Navigation cleanup does not fix the legacy unit display. |
| 5 | Process Orders | `/orders` | Customer order list and navigation to individual order processing. | **Top level:** “Customer Orders”. |
| 6 | Subtypes | `/subtypes` | Edits items with subtypes using `SubtypeRow`. | **Tools:** Inventory → Subtypes. Still a maintenance tool. |
| 7 | Subtype Exceptions | `/subtype-exceptions` | Resolves ambiguous/bare-JAN variant identities; links to item history. | **Tools:** Inventory → Subtype Exceptions; retain links from issue screens. |
| 8 | Payments | `/payments` | Reads PayPal capture information from the `dobutsu` collection. It is not supplier-payment entry or a general financial ledger. | **Obsolete:** “PayPal payment history (legacy)”. Confirm whether the old payment channel is still used. |
| 9 | Export CSV | `/csv` | Exports inventory fields, with download/Google Drive options. | **Tools:** Inventory → Export CSV. This remains useful and is not replaced by a customs workbook or Shopify-format CSV. |
| 10 | Manage Names | `/names` | Maintains saved names/codes used by `ComboBox`. | **Tools:** Inventory → Saved names and codes. Shared components still use this data, so do not call it obsolete or remove its events. |
| 11 | Archives | `/archives` | Lists inventory snapshots and emits `archive_inventory`. It is an inventory operation, not a menu of old pages. | **Obsolete:** “Archives”; keep `/archives`. Confirm any continuing stocktake use. |
| 12 | Audit Log | `/audit` | Inspects the action history and replay/debugging information. | **Tools:** Account → Audit Log; also reachable from Sync Status for investigation. |
| 13 | Account | `/account` | Authentication, Google connection and cached-state reset. | **Top level**. |
| 14 | Item History | `/itemhistory` | Per-item stock/cost history and investigation. Already linked from several issue and marketplace pages. | **Tools:** inventory/product item actions; retain a general entry under Inventory tools. |
| 15 | Jan Codes | `/jancodes` | Despite its label, shows “Items with a blank subtype” using `SubtypeRow`; it is not a general barcode registry. | **Obsolete:** “Blank-subtype editor (legacy)”. Confirm that Inventory/Subtypes/Exceptions cover the remaining editing needs; a blank subtype is not inherently an error. |
| 16 | Receive Order | `/order-receipt` | Saved receiving review and once-only inventory/company-use acceptance. | **Top level**. |
| 17 | Order Import | `/order-import` | Supplier CSV matching/conflict resolution and batch stock additions. | **Obsolete:** “Supplier CSV stock import (legacy)”. Customs → Receive Order becomes the normal incoming-order path. Keep this available for explicit compatibility/recovery cases. |
| 18 | Customs Summary | `/customs-summary` | Imports source Sheets, reviews classifications and exports customs tables. | **Top level**. |
| 19 | Live Event Import | `/live-event-import` | Parses event sales and records an outgoing customer/event order. | **Top level**. Not superseded by supplier receiving. |
| 20 | Photo History | `/photo-history` | Per-photo history with processing/retry/edit controls; Photos already links to it with photo context. | **Tools:** Photos → Photo History / per-photo action. Not a legacy replacement for Photos. |
| 21 | Photos | `/photos` | Current photo workflow. | **Top level**. |
| 22 | Shopify Import | `/shopify-import` | Imports Shopify product CSV data and can reconcile local inventory/listing fields and quantities. | **Obsolete:** “Shopify CSV import (legacy)”. Confirm any continuing bulk-maintenance use; outbound Shopify sync is not a complete replacement for every CSV import operation. |
| 23 | Shopify Products | `/shopify-products` | Local product/listing editing and Shopify-format export. | **Top level:** “Product Catalog”. |
| 24 | Shopify Listings | `/shopify-listings` | Catalog comparison, listing differences and outbound publication/sync. | **Top level**. |
| 25 | Sync Status | `/sync-status` | Cross-job status and diagnostic history. | **Top level** during current integration work. |
| 26 | Shows | `/shows` | Creates/views event sales inferred from inventory archives; can export those sales. | **Obsolete:** “Archive-based event sales (legacy)”. Live Event Import is the proposed path for new sales; retain historical viewing here. |
| 27 | SKU Review | `/sku-review` | Reviews missing/inconsistent product metadata and applies repairs, including sheet-assisted updates. | **Tools:** Product Catalog → SKU Review. Useful preparation/repair tooling, not obsolete. |
| 28 | Order Exceptions | `/order-exceptions` | Repairs historical supplier receipt costs, dates, exchange/payment facts and stock-order issues; includes stock-changing operations. | **Tools:** Inventory Value → Order Exceptions. New receiving covers new receipts, but does not replace historical repairs or provide completed-receipt corrections. |
| 29 | Inventory Value | `/inventory-value` | Inventory valuation. | **Top level**. |
| 30 | Cost Issues | `/unpriced` | Diagnoses and repairs missing/incorrect cost ledger facts, with item-history and ledger-editor links. | **Tools:** Inventory Value → Cost Issues. Keep easy to find; do not archive because receiving now collects costs. |
| 31 | Test Edit | `/test-edit` | Gemini image-edit testbed. | **Obsolete:** “Image edit testbed”. Keep normal photo work in Photos. |
| 32 | DevTools | `/devtools` | Developer inspection/debugging screen. | **Tools:** Account → Developer tools. It is specialist rather than obsolete. |


Accounting: **13 original operational links + 11 Tools links + 8 Obsolete links = 32 original destinations**. Adding Amazon Listings gives 14 operational links; Tools and Obsolete bring the top-level count to 16.

## Dashboard and interaction

- Replace the dashboard Add Inventory shortcut with Receive Order, and the Export CSV tile with Customs Summary. CSV export remains in Tools.
- Use Inventory and Customer Orders labels consistently. Keep Create Listings and leave dashboard metrics/activity behavior unchanged.
- Both groups use native `details`/`summary` disclosures, with built-in keyboard and expanded-state semantics. They start closed on ordinary pages and automatically open when navigating directly to one of their child routes.
- Highlight the current child and its parent group. Query parameters do not affect navigation matching.
- Map `/order` to Customer Orders, `/listing-detail` to Product Catalog, `/shopify-listings/diff` to Shopify Listings, `/cost-ledger-editor` to Cost Issues, and `/rekeyitem` to Inventory. Preserve contextual URLs and query parameters.
- On mobile, toggling a group keeps the drawer open; following a link closes it. Preserve visible keyboard focus. Add an outside Open navigation button: the previous toggle was inside the closed, off-screen drawer and could not reopen it.
- Use scoped Svelte styles and existing sidebar spacing/colors; no global redesign, new permissions or new confirmation dialogs.
- No `/tools`, `/obsolete` or `/archived` landing page is needed. Existing bookmarks continue working.

## Scope and validation

Implementation changes [Navigation.svelte](src/lib/components/Navigation.svelte) and [dashboard shortcuts](src/routes/+page.svelte). No contextual-link rollout is required now that all 11 tools have a top-level group. No route is removed, and no backend, event schema, inventory calculation or marketplace operation changes.

Verify all original destinations plus Amazon remain reachable; both disclosures work with keyboard and mobile navigation; direct tool/obsolete URLs open and highlight the appropriate group; query-bearing routes retain context; dashboard shortcuts agree with the supplier lifecycle. Run formatting/type checks, focused browser checks and repository-required checks. Push the existing Amazon branch and deploy hosting to staging as requested. No production deployment.

Sources: [order lifecycle](ORDER_RECEIPTS.md), [Amazon completion plan](AMAZON_SYNC_COMPLETION.md), and the route implementations listed above. The staging data reset is not evidence that any empty route is obsolete.
