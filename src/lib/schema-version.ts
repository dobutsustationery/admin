/**
 * Redux State Schema Version
 * Increment this number to invalidate all hydrated state and force a full replay of broadcast actions.
 * Use this whenever the shape of the state changes in a non-backward-compatible way.
 */
// 5: `cost` is now DERIVED from a per-item receipt/sale costLedger
//    (perpetual weighted-average) instead of last-write. Hydrated v4
//    snapshots carry stale last-write cost and no costLedger, so they
//    must be discarded and re-derived via full replay. See
//    docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md
// 6: subsequent derived-cost changes (sale interleaving, Total÷PCS
//    order-cost parser, lot `source` tagging, and the auto-populated
//    stockOrderRegistry for the order-exceptions route) all change the
//    materialised costLedger / registry. A v5 snapshot from an earlier
//    replay lacks them, so it must be discarded and fully re-derived.
//    See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md
// 7: archive sales now carry an `isArchive` flag and `walkLedger`
//    carries the pre-archive weighted-average across an archive's
//    zero-crossing (so an unpriced post-archive recount lot inherits
//    historical cost instead of silently zeroing it). v6 snapshots
//    lack the flag on their sale entries and would produce stale €0
//    averages on items affected by a stock-take wipe — discard and
//    re-derive.
// 8: stock-order late-scan issues are now materialised by the same
//    reducer-side cost issue refresh as unmatched/overmatched rows.
//    v7 browser snapshots may contain ledger/order issue combinations
//    produced by older allocation logic and must replay from broadcast.
// 9: late-scan stock-order receipt reconstruction now consumes a JAN's
//    expected order quantity once and splits it across the JAN's late
//    subtype scan receipts instead of adding the full order row to each
//    subtype. v8 snapshots may contain duplicated reconstructed lots and
//    must replay from broadcast.
// 10: reducer-created recount/quantity-adjustment receipts now carry
//     `receivedQty: 0` so they preserve cost basis for stock valuation and
//     later sales without inflating cumulative received purchase value.
// 11: sale ledger entries now use the order/event date, not the
//     webhook/reconciliation/entry date. The cost walk also carries a
//     sale with no same-day on-hand stock forward to the next receipt so
//     replay does not drop dated sales that precede their priced receipt.
// 12: pre-Japan-Festival package_item/quantify_item sales for multi-piece
//     items now record fractional cost-ledger sale quantities (qty / pieces)
//     while leaving order/shipped quantities as entered. v11 snapshots
//     over-deplete old loose-piece sales and must replay from broadcast.
// 13: fractional loose-piece sale entries also keep their operator-visible
//     sale quantity so visible-qty receipt corrections do not reinterpret
//     historical scans as new receipts.
// 14: Shopify order replay now materialises unresolved active line items on
//     `order.unmatchedLines` so `/orders` and `/order` can expose missing
//     Shopify lines instead of silently displaying only matched facts.
// 15: bare numeric Shopify JANs with no historical binding now resolve to the
//     single current subtyped inventory item for that JAN when unambiguous.
//     v14 snapshots preserve the old unmatched order projection.
// 16: Amazon catalog probes, listing writes, and product-type discoveries now
//     materialise raw SP-API responses into the `amazonCatalog` Redux slice.
//     v15 snapshots can contain the broadcast actions but no replayed Amazon
//     catalog state, so the Amazon listings route would appear empty until a
//     manual replay. Force one automatic replay.
// 17: Amazon product-type discovery now records only top-level required
//     attributes from the linked Amazon schema. v16 snapshots may contain
//     overbroad SELF_STICK_NOTE requirements from an earlier discovery.
// 18: Local Amazon discovery/probe/write test artifacts were cleared from the
//     emulator while this branch is still in development; force browser state
//     to rebuild from the fresh emulator action log.
// 19: Amazon product-type schemas are now stored as separate raw responses, and
//     required/property field lists are reducer-derived state.
// 20: Amazon listing-restriction checks are now materialised in the
//     amazonCatalog slice, and duplicate-JAN variation payloads derive
//     product-identifier exemption fields instead of repeated EAN identity.
export const CURRENT_SCHEMA_VERSION = 20;
