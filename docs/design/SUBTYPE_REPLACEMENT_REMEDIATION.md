# Subtype Replacement Remediation Design

## Status

Draft. This records the design direction for a future remediation tool. No
implementation is planned in the current workstream.

## Problem

Some JANs have a subtype that was entered under the wrong label and later
re-entered under the intended label. If the original subtype has historical
receipts, archive sales, order references, or cost ledger rows, treating the
new label as a new independent subtype loses the identity continuity.

The symptom looks similar to an unpriced receipt, but the correct fix is
different. The new subtype does not need a second stock-order allocation. The
old subtype's identity, history, and cost basis should move to the new subtype.

## Example: `4542804104370`

The operator intended `Beige` to replace `Brown`.

Historical state:

- `4542804104370Brown` existed from an old scan with qty 5.
- `4542804104370Cream` existed from an old scan with qty 5.
- Both were archived out on May 2, 2025.
- The stock order for JAN `4542804104370` later supplied qty 10 at `¥65`.
- The allocator attached the cost to the old Brown and Cream receipts.

Operator actions on May 8, 2025:

- `update_item` for id `"4542804104370 Beige"`, `janCode:
  "4542804104370 "`, subtype `Beige`, qty 5.
- `update_item` for id `"4542804104370 Cream"`, `janCode:
  "4542804104370 "`, subtype `Cream`, qty 5.
- `rename_subtype` from `4542804104370Cream` to `Cream`, which was a no-op.

There was no actual `Brown -> Beige` rename action in the broadcast log. The
system interpreted the Beige scan as a new subtype. That left:

- `Brown` with the old priced receipt and archive sale.
- `Beige` with a new May 8 receipt at `unitCostJpy: 0`.

Inventory valuation then showed Beige with average cost 0 even though item-level
metadata had cost 65.

## Why Cost Adjustment Alone Is Wrong

A simple "price this Beige receipt" fix would make the displayed cost look
better, but it would also imply Beige is an additional receipt consuming the
same stock order after Brown and Cream already consumed the order quantity.

For this case, Beige is not a third subtype in the order allocation. Beige is
the corrected label for Brown. The remediation should preserve identity across
the label correction.

## Proposed Remediation

Add an audited subtype replacement operation:

```text
replace_subtype_identity({
  fromItemKey: "4542804104370Brown",
  toItemKey: "4542804104370Beige",
  reason: "Brown was entered under the wrong subtype; Beige is the intended label."
})
```

The operation should:

- Move cost ledger entries from `fromItemKey` to `toItemKey`.
- Merge item history from `fromItemKey` into `toItemKey`, prefixed or annotated
  so the old key remains auditable.
- Rewrite order references from `fromItemKey` to `toItemKey`.
- Rewrite listing/inventory references where applicable.
- Remove `fromItemKey`, or leave an archived/replaced marker if hard removal
  would hide useful audit context.
- Add explicit history rows to both keys, if both remain visible during replay.
- Add an audit comment to affected cost ledger rows.

The result for `4542804104370` should be:

- Brown's old priced receipt and archive sale become Beige's historical cost
  basis.
- Beige's May 8 scan is treated as the post-archive restock for that same
  identity.
- The moving-average/carry-forward logic can value Beige at `¥65`, as Cream
  already does.
- No extra stock-order consumption is created.

## UI Flow

This belongs with the subtype exception/remediation screen.

For a JAN with both inactive/zero old subtypes and later active new subtypes,
the detail screen should offer:

- Split bare item into subtypes.
- Merge subtypes back into bare JAN.
- Replace one subtype identity with another.

For "replace subtype identity", the screen should show:

- Source subtype and target subtype.
- Current quantities.
- Key history rows for both sides.
- Cost ledger before/after.
- Order/listing references that will be rewritten.
- A required audit reason.

The preview should make clear whether the operation changes total on-hand qty.
For an identity replacement, it normally should not create new stock quantity or
new stock-order consumption.

## Reducer Requirements

The reducer operation must be deterministic under replay and should use existing
key migration helpers where possible:

- `renameInventoryEntityKey`
- `migrateCostLedger`
- `rewriteOrderItemKeyReferences`

However, this is not the same as ordinary `rename_subtype`, because the target
may already exist. The reducer needs a deliberate merge policy for:

- qty
- shipped
- cost ledger rows
- item metadata conflicts
- history ordering
- listing references

If metadata conflicts exist, the action should either:

- be rejected in preview and not broadcast, or
- carry explicit resolution choices in the payload.

## Audit Requirements

Every replacement must leave a clear mark:

- History row: `Replaced subtype Brown with Beige: <reason>`.
- Cost ledger audit comment on moved rows.
- Optional Cost Issues/Audit Adjustments row so these changes remain visible.

The audit record should explain that this is an identity correction, not a new
receipt pricing adjustment.

## Open Questions

- Should the old item key be deleted, archived, or retained as a zero-qty
  replaced marker?
- If both source and target have non-zero qty, should replacement be allowed, or
  must the user first choose how quantities merge?
- Should post-archive unpriced receipts inherit cost via existing carry-forward,
  or should the replacement action explicitly price them?
- Should this be generalized as key merge/remap, or kept as a subtype-specific
  remediation to reduce risk?

