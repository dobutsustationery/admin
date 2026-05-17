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
export const CURRENT_SCHEMA_VERSION = 5;
