// Pure selector for the order-exceptions route.
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §3
import type { InventoryState, StockOrderMeta } from "./inventory";
import { UNKNOWN_RECEIPT_DATE, BGN_PER_EUR, walkLedger } from "./cost-engine";

export interface OrderExceptionRow {
  orderId: string;
  name: string;
  receivedAt?: number;
  valueOfGoodsJpy?: number;
  valueOfOrderJpy?: number;
  totalOrderEur?: number;
  paidCurrency?: "EUR" | "BGN";
  paidAmount?: number;
  lotCount: number;
  unpricedCount: number;
  flags: {
    dateUnknown: boolean;
    goodsValueUnknown: boolean;
    orderValueUnknown: boolean;
    paidUnknown: boolean;
    needsCost: boolean;
  };
  isException: boolean;
}

/**
 * One row per registered stock order with each gap flagged. A row is an
 * exception if ANY gap is present (design §3). Pure; the route filters
 * to `isException` for the list and uses the full row for the detail.
 */
export function selectOrderExceptions(
  state: Pick<InventoryState, "stockOrderRegistry" | "costLedger">,
): OrderExceptionRow[] {
  const registry = state.stockOrderRegistry || {};
  const ledger = state.costLedger || {};

  const rows: OrderExceptionRow[] = [];
  for (const orderId of Object.keys(registry)) {
    const m = registry[orderId];
    const tag = `stockOrder:${orderId}`;

    let lotCount = 0;
    let unpricedCount = 0;
    for (const key of Object.keys(ledger)) {
      for (const e of ledger[key]) {
        if (e.kind === "receipt" && e.source === tag) {
          lotCount++;
          if (!(e.unitCostJpy > 0)) unpricedCount++;
        }
      }
    }

    const flags = {
      dateUnknown:
        m.receivedAt == null || m.receivedAt === UNKNOWN_RECEIPT_DATE,
      goodsValueUnknown: m.valueOfGoodsJpy == null,
      orderValueUnknown: m.valueOfOrderJpy == null,
      paidUnknown: m.totalOrderEur == null,
      needsCost: unpricedCount > 0,
    };

    rows.push({
      orderId,
      name: m.name || orderId,
      receivedAt: m.receivedAt,
      valueOfGoodsJpy: m.valueOfGoodsJpy,
      valueOfOrderJpy: m.valueOfOrderJpy,
      totalOrderEur: m.totalOrderEur,
      paidCurrency: m.paidCurrency,
      paidAmount: m.paidAmount,
      lotCount,
      unpricedCount,
      flags,
      isException: Object.values(flags).some(Boolean),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/** Normalise the real paid amount to EUR (lev is pegged). */
export function paidToEur(meta: StockOrderMeta): number | undefined {
  if (meta.paidAmount == null || !meta.paidCurrency) return meta.totalOrderEur;
  return meta.paidCurrency === "BGN"
    ? meta.paidAmount / BGN_PER_EUR
    : meta.paidAmount;
}

export interface OrderFixPreviewItem {
  key: string;
  lotsInOrder: number;
  oldCostJpy?: number;
  newCostJpy?: number;
  oldCostEur?: number;
  newCostEur?: number;
}

export interface OrderFixPreview {
  orderId: string;
  fx: number;
  receivedAt?: number;
  affectedLots: number;
  items: OrderFixPreviewItem[];
}

/**
 * Pure projection of what `set_stock_order_meta(orderId, proposed)`
 * would do to this order's source-tagged lots — for the
 * preview-before-commit screen. Does not mutate state.
 */
export function previewOrderMetaFix(
  state: Pick<InventoryState, "stockOrderRegistry" | "costLedger">,
  orderId: string,
  proposed: StockOrderMeta,
): OrderFixPreview {
  const eff: StockOrderMeta = {
    ...(state.stockOrderRegistry?.[orderId] || {}),
    ...proposed,
  };
  const totalOrderEur = paidToEur(eff);
  const fx =
    totalOrderEur && (eff.valueOfOrderJpy || 0) > 0
      ? totalOrderEur / (eff.valueOfOrderJpy as number)
      : 0;
  const receivedAt =
    eff.receivedAt && eff.receivedAt > 0 ? eff.receivedAt : undefined;
  const tag = `stockOrder:${orderId}`;
  const ledger = state.costLedger || {};

  const items: OrderFixPreviewItem[] = [];
  let affectedLots = 0;
  for (const key of Object.keys(ledger)) {
    const orig = ledger[key];
    const inOrder = orig.filter(
      (e) => e.kind === "receipt" && e.source === tag,
    ).length;
    if (inOrder === 0) continue;
    affectedLots += inOrder;
    const projected = orig.map((e) => {
      if (e.kind !== "receipt" || e.source !== tag) return e;
      return {
        ...e,
        at: receivedAt ?? e.at,
        unitCostEur: fx > 0 ? e.unitCostJpy * fx : e.unitCostEur,
      };
    });
    const before = walkLedger(orig);
    const after = walkLedger(projected);
    items.push({
      key,
      lotsInOrder: inOrder,
      oldCostJpy: before.avgJpy,
      newCostJpy: after.avgJpy,
      oldCostEur: before.avgEur,
      newCostEur: after.avgEur,
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  return { orderId, fx, receivedAt, affectedLots, items };
}
