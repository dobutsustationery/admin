# Fractional Pre-Festival Sales

## Summary

Some inventory items were originally sold as loose pieces from a multi-piece retail unit, then sold only as whole units after the Japan Festival stock-take. The action log records those old order quantities as the number of loose pieces sold, but the current cost ledger interprets the same quantity as whole inventory units. This over-depletes early receipts and can create pending sale debt that consumes later receipts.

Examples:

- `4901681382316Standard`: a 12-marker set. Historical sales entered as individual markers currently consume whole marker sets.
- `4902850041522`: a 10-envelope pack. Historical sales entered as loose envelopes currently consume whole packs.

This investigation used a read-only emulator export:

- Export: `/tmp/admin2-piece-sales-investigation/firestore-export.json`
- Replay dump: `/tmp/admin2-piece-sales-investigation/inventory-dump.json`
- Impact summaries:
  - `/tmp/admin2-piece-sales-investigation/piece-sales-impact.json`
  - `/tmp/admin2-piece-sales-investigation/piece-sales-impact-mapped.json`

## Current Behavior

`package_item` and `quantify_item` currently apply one quantity delta to three concepts:

1. The order line quantity.
2. The item's `shipped` count.
3. The cost ledger sale quantity.

For whole-unit products this is correct. For the old pre-festival loose-piece sales it is not. If `pieces = 10` and the operator entered `9`, the order line means "9 envelopes", while the cost ledger currently records a sale of 9 packs. The cost ledger should record `9 / 10 = 0.9` inventory units.

`archive_inventory` already has a separate `effectiveArchiveQuantity` helper that understands `pieces`. That means the Japan Festival archive was intended to be a boundary between the old loose-piece operating mode and the later whole-unit operating mode. The bug is specifically that ordinary sales before that boundary did not apply the same interpretation.

## Estimated Impact

The emulator replay found:

| Metric | Estimate |
|---|---:|
| Affected item groups | 54 |
| Affected pre-festival sale actions | 407 |
| Current ledger sale qty | 667.5 whole units |
| Correct fractional sale qty | 62.1066 whole units |
| Over-depletion | 605.3934 whole units |
| Estimated overstated pre-festival sold value | about JPY 100,002 |
| Groups with pending sales consuming future receipts | 25 |
| Pending sale qty before Japan Festival under current interpretation | 452 units |
| Pending sale qty after fractional interpretation | 0 units |
| Extra stock that should remain until Japan Festival archive | about 162.8446 whole units across 52 groups |

Top examples by estimated value:

| Item group | Pieces | Current sale qty | Correct sale qty | Over-depletion | Est. value |
|---|---:|---:|---:|---:|---:|
| `4901681382316Standard` | 12 | 33 | 2.75 | 30.25 | JPY 19,239 |
| `4902505414268` | 12 | 23 | 1.9167 | 21.0833 | JPY 17,534 |
| `4902778211625` | 8 | 15 | 1.875 | 13.125 | JPY 11,852 |
| `4901681506606` | 12 | 13 | 1.0833 | 11.9167 | JPY 10,383 |
| `4902850041522` | 10 | 86 | 8.6 | 77.4 | JPY 8,003 |

The examples named in the prompt:

| Item group | Pieces | Current sale qty | Correct sale qty | Over-depletion | Est. value |
|---|---:|---:|---:|---:|---:|
| `4901681382316Standard` | 12 | 33 | 2.75 | 30.25 | JPY 19,239 |
| `4902850041522` | 10 | 86 | 8.6 | 77.4 | JPY 8,003 |

## Design

Interpret pre-Japan-Festival sales for multi-piece items as fractional inventory-unit sales.

For `package_item` and `quantify_item`, keep the existing order line quantity unchanged, but compute the cost ledger quantity separately:

```ts
orderQtyDelta = newOrderLineQty - previousOrderLineQty;

if (sale date is before the Japan Festival archive && item.pieces > 1) {
  ledgerSaleQty = orderQtyDelta / item.pieces;
} else {
  ledgerSaleQty = orderQtyDelta;
}
```

This should apply to positive and negative deltas. A `quantify_item` correction from `1` to `0` should restore `1 / pieces` inventory units, not one whole unit.

The item `shipped` counter should continue to reflect the historical order-line unit used by the operator. The cost ledger is the part that needs inventory-unit normalization for valuation.

## Auditability

Sale ledger entries created by this interpretation should carry an audit comment such as:

```text
Loose-piece sale: 9 piece(s) / 10 pieces per unit = 0.9 inventory unit(s).
```

This keeps item history/order history readable as originally entered while making the valuation ledger explain why the cost quantity differs from the order line quantity.

## Tests

Add focused reducer tests for:

- `package_item` before the Japan Festival boundary with `pieces = 10` records a sale of `0.1`.
- `quantify_item` from `1` to `9` records an incremental sale of `0.8`.
- `quantify_item` from `1` to `0` records a negative sale of `-0.1`.
- Post-Japan-Festival sales remain whole-unit sales.
- A representative replay case no longer leaves pending sale debt that consumes later receipts.

## Risk

The main risk is applying fractional semantics to a post-festival item that is actually sold as a whole unit. The Japan Festival archive boundary is therefore part of the rule. It matches the operational change described during investigation and prevents the new behavior from touching later whole-unit sales.

