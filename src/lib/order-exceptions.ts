// Pure selector for the order-exceptions route.
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §3
import type { InventoryState, StockOrderMeta } from "./inventory";
import { UNKNOWN_RECEIPT_DATE, BGN_PER_EUR, walkLedger } from "./cost-engine";
import {
  parseStockOrderCostTsv,
  reconcileStockOrderCostTsv,
  type StockOrderCostReconciliation,
} from "./stock-order-cost-tsv";

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

export interface StockOrderCostCommitMatch {
  key: string;
  jan: string;
  subtype: string;
  qty: number;
  oldUnitJpy: number;
  newUnitJpy: number;
  isOverride: boolean;
}

export interface StockOrderCostCommitPreview {
  reconciliation: StockOrderCostReconciliation;
  matched: StockOrderCostCommitMatch[];
  unmatchedJans: string[]; // TSV rows with no lot in this order
  affected: { key: string; oldCostJpy?: number; newCostJpy?: number }[];
}

/**
 * Pure preview for the staged TSV: reconcile to value-of-goods, match
 * each row to this order's source-tagged lots, and project the
 * re-derived item cost. No mutation. Mirrors the live-event commit
 * preview. Same matching the apply reducer uses.
 */
export function computeStockOrderCostCommit(args: {
  rawPaste: string;
  orderId: string;
  overrideExisting: boolean;
  inventory: Pick<
    InventoryState,
    "costLedger" | "idToItem" | "stockOrderRegistry"
  >;
}): StockOrderCostCommitPreview {
  const { rawPaste, orderId, overrideExisting, inventory } = args;
  const reg = inventory.stockOrderRegistry?.[orderId];
  const reconciliation = reconcileStockOrderCostTsv(
    parseStockOrderCostTsv(rawPaste),
    reg?.valueOfGoodsJpy,
  );
  const want = new Map<string, number>();
  for (const row of reconciliation.rows)
    want.set(`${row.jan}|${row.subtype || ""}`, row.unitCostJpy);

  const tag = `stockOrder:${orderId}`;
  const ledger = inventory.costLedger || {};
  const matched: StockOrderCostCommitMatch[] = [];
  const matchedRowKeys = new Set<string>();
  const affected: { key: string; oldCostJpy?: number; newCostJpy?: number }[] =
    [];

  for (const key of Object.keys(ledger)) {
    const item = inventory.idToItem[key];
    if (!item) continue;
    const orig = ledger[key];
    let anyChange = false;
    const projected = orig.map((e) => {
      if (e.kind !== "receipt" || e.source !== tag) return e;
      const rk = `${item.janCode}|${item.subtype || ""}`;
      const v = want.get(rk) ?? want.get(`${item.janCode}|`);
      if (v == null) return e;
      matchedRowKeys.add(want.has(rk) ? rk : `${item.janCode}|`);
      const priced = e.unitCostJpy > 0;
      const isOverride = priced;
      if (priced && !overrideExisting) return e;
      matched.push({
        key,
        jan: item.janCode,
        subtype: item.subtype || "",
        qty: e.qty,
        oldUnitJpy: e.unitCostJpy,
        newUnitJpy: v,
        isOverride,
      });
      anyChange = true;
      return { ...e, unitCostJpy: v };
    });
    if (anyChange) {
      affected.push({
        key,
        oldCostJpy: walkLedger(orig).avgJpy,
        newCostJpy: walkLedger(projected).avgJpy,
      });
    }
  }

  const unmatchedJans = reconciliation.rows
    .filter(
      (r) =>
        !matchedRowKeys.has(`${r.jan}|${r.subtype || ""}`) &&
        !matchedRowKeys.has(`${r.jan}|`),
    )
    .map((r) => r.jan);

  return { reconciliation, matched, unmatchedJans, affected };
}

export interface StockOrderFixItem {
  key: string;
  oldCostJpy?: number;
  newCostJpy?: number;
  oldCostEur?: number;
  newCostEur?: number;
}

export interface StockOrderFixPreview {
  fx: number;
  receivedAt?: number;
  affectedLots: number;
  // ONE combined old→new per affected item: meta (date/EUR) AND the
  // reconciled TSV applied together — exactly what the single commit does.
  items: StockOrderFixItem[];
  reconciliation: StockOrderCostReconciliation | null;
  matched: StockOrderCostCommitMatch[];
  unmatchedJans: string[];
  blocked: boolean;
}

/**
 * Unified preview for the single atomic order fix. Projects the proposed
 * meta (receipt date + paid→EUR) AND the reconciled cost TSV onto this
 * order's source-tagged lots TOGETHER, then walks each affected item's
 * cost old→new. Pure; mirrors exactly what `fix_stock_order` commits.
 */
export function previewStockOrderFix(
  inventory: Pick<
    InventoryState,
    "stockOrderRegistry" | "costLedger" | "idToItem"
  >,
  orderId: string,
  opts: {
    meta: StockOrderMeta;
    rawPaste: string;
    overrideExisting: boolean;
    approveDiscrepancy: boolean;
  },
): StockOrderFixPreview {
  const eff: StockOrderMeta = {
    ...(inventory.stockOrderRegistry?.[orderId] || {}),
    ...opts.meta,
  };
  const totalOrderEur = paidToEur(eff);
  const fx =
    totalOrderEur && (eff.valueOfOrderJpy || 0) > 0
      ? totalOrderEur / (eff.valueOfOrderJpy as number)
      : 0;
  const receivedAt =
    eff.receivedAt && eff.receivedAt > 0 ? eff.receivedAt : undefined;

  const cost = opts.rawPaste.trim()
    ? computeStockOrderCostCommit({
        rawPaste: opts.rawPaste,
        orderId,
        overrideExisting: opts.overrideExisting,
        inventory: {
          ...inventory,
          stockOrderRegistry: {
            ...inventory.stockOrderRegistry,
            [orderId]: eff,
          },
        },
      })
    : null;
  const reconciliation = cost?.reconciliation ?? null;
  const want = new Map<string, number>();
  if (reconciliation)
    for (const r of reconciliation.rows)
      want.set(`${r.jan}|${r.subtype || ""}`, r.unitCostJpy);

  const tag = `stockOrder:${orderId}`;
  const ledger = inventory.costLedger || {};
  const items: StockOrderFixItem[] = [];
  let affectedLots = 0;

  for (const key of Object.keys(ledger)) {
    const orig = ledger[key];
    const item = inventory.idToItem[key];
    let inOrder = 0;
    const projected = orig.map((e) => {
      if (e.kind !== "receipt" || e.source !== tag) return e;
      inOrder++;
      let unitCostJpy = e.unitCostJpy;
      if (item) {
        const v =
          want.get(`${item.janCode}|${item.subtype || ""}`) ??
          want.get(`${item.janCode}|`);
        if (v != null && (!(e.unitCostJpy > 0) || opts.overrideExisting))
          unitCostJpy = v;
      }
      const unitCostEur = fx > 0 ? unitCostJpy * fx : e.unitCostEur;
      return {
        ...e,
        at: receivedAt ?? e.at,
        unitCostJpy,
        unitCostEur,
      };
    });
    if (inOrder === 0) continue;
    affectedLots += inOrder;
    const before = walkLedger(orig);
    const after = walkLedger(projected);
    items.push({
      key,
      oldCostJpy: before.avgJpy,
      newCostJpy: after.avgJpy,
      oldCostEur: before.avgEur,
      newCostEur: after.avgEur,
    });
  }
  items.sort((a, b) => a.key.localeCompare(b.key));

  const blocked =
    !!reconciliation &&
    (!reconciliation.chosen ||
      reconciliation.rows.length === 0 ||
      (!reconciliation.reconciled &&
        reconciliation.discrepancy != null &&
        !opts.approveDiscrepancy) ||
      (!!cost &&
        cost.matched.some((m) => m.isOverride) &&
        !opts.overrideExisting));

  return {
    fx,
    receivedAt,
    affectedLots,
    items,
    reconciliation,
    matched: cost?.matched ?? [],
    unmatchedJans: cost?.unmatchedJans ?? [],
    blocked,
  };
}
