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
export const CURRENT_SCHEMA_VERSION = 9;
