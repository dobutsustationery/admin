// Pure selector for the order-exceptions route.
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §3
import type { InventoryState, Item, StockOrderMeta } from "./inventory";
import {
  UNKNOWN_RECEIPT_DATE,
  BGN_PER_EUR,
  walkLedger,
  lotMatchesOrder,
  type LedgerEntry,
  type ReceiptEntry,
} from "./cost-engine";
import {
  parseStockOrderCostTsv,
  reconcileStockOrderCostTsv,
  buildInterpretation,
  reconcileManual,
  type StockOrderCostReconciliation,
  type TsvColumn,
} from "./stock-order-cost-tsv";

export type ManualInterpretation = {
  kind: "unit" | "total";
  costColumnIndex: number;
  qtyColumnIndex: number;
  // undefined = auto-detect; -1 = explicitly none; >=0 = that column.
  countryColumnIndex?: number;
  weightColumnIndex?: number;
};

/** Columns + the auto interpretation, for the manual-override UI. */
export function stockOrderCostColumns(
  rawPaste: string,
  valueOfGoodsJpy: number | undefined,
  expectedItemCount?: number,
): {
  columns: TsvColumn[];
  headerRows: number;
  auto: ManualInterpretation | null;
  // Auto-detected COO/weight columns, surfaced so the UI can show the
  // chosen column even when no cost interpretation reconciled. -1 = none.
  countryColumnIndex: number;
  weightColumnIndex: number;
} {
  const p = parseStockOrderCostTsv(rawPaste);
  const r = reconcileStockOrderCostTsv(p, valueOfGoodsJpy, expectedItemCount);
  return {
    columns: p.columns,
    headerRows: p.headerRows,
    auto: r.chosen
      ? {
          kind: r.chosen.kind,
          costColumnIndex: r.chosen.costColumnIndex,
          qtyColumnIndex: r.chosen.qtyColumnIndex,
          countryColumnIndex: r.chosen.countryColumnIndex,
          weightColumnIndex: r.chosen.weightColumnIndex,
        }
      : null,
    countryColumnIndex: p.countryCol,
    weightColumnIndex: p.weightCol,
  };
}

export interface OrderExceptionRow {
  orderId: string;
  name: string;
  receivedAt?: number;
  valueOfGoodsJpy?: number;
  valueOfOrderJpy?: number;
  expectedItemCount?: number;
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
    let lotCount = 0;
    let unpricedCount = 0;
    for (const key of Object.keys(ledger)) {
      for (const e of ledger[key]) {
        if (lotMatchesOrder(e, orderId)) {
          lotCount++;
          if (!((e as any).unitCostJpy > 0)) unpricedCount++;
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
      expectedItemCount: m.expectedItemCount,
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
    const inOrder = orig.filter((e) => lotMatchesOrder(e, orderId)).length;
    if (inOrder === 0) continue;
    affectedLots += inOrder;
    const projected = orig.map((e) => {
      if (!lotMatchesOrder(e, orderId) || e.kind !== "receipt") return e;
      // Only move the date for lots the order actually created
      // (source-tagged); a cost-attach to a pre-existing scan lot
      // keeps its scan date — only its EUR is re-derived.
      const fromThisOrder = e.source === tag;
      return {
        ...e,
        at: fromThisOrder ? (receivedAt ?? e.at) : e.at,
        unitCostEur:
          fx > 0 ? (e as any).unitCostJpy * fx : (e as any).unitCostEur,
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
  qty: number;
  oldUnitJpy: number;
  newUnitJpy: number;
  isOverride: boolean;
}

export type StockOrderMatchKind =
  | "match"
  | "fix cost"
  | "override cost"
  | "fix coo"
  | "fix weight"
  | "warning"
  | "unmatched";

export interface StockOrderCostMatchRow {
  rowIndex: number;
  jan: string;
  qty: number;
  unitCostJpy: number;
  lineCostJpy: number;
  key?: string;
  item?: Pick<
    Item,
    "description" | "image" | "countryOfOrigin" | "weight" | "subtype"
  >;
  status: string;
  kinds: StockOrderMatchKind[];
  isUnmatched: boolean;
  isOverride: boolean;
  costWillApply: boolean;
  incomingCountryOfOrigin?: string;
  incomingWeight?: number;
  canFixCountryOfOrigin: boolean;
  canFixWeight: boolean;
  countryOfOriginMismatch: boolean;
  weightMismatch: boolean;
}

export interface StockOrderCostCommitPreview {
  reconciliation: StockOrderCostReconciliation;
  matched: StockOrderCostCommitMatch[];
  matchRows: StockOrderCostMatchRow[];
  unmatchedJans: string[]; // TSV rows with no lot in this order
  affected: { key: string; oldCostJpy?: number; newCostJpy?: number }[];
}

function findZeroedAllocationCandidate(
  inventory: Pick<InventoryState, "costLedger" | "idToItem">,
  jan: string,
  receivedAt?: number,
): { key: string; item: Item; oldUnitJpy: number; qty: number } | undefined {
  if (!receivedAt || receivedAt === UNKNOWN_RECEIPT_DATE) return undefined;
  const ledger = inventory.costLedger || {};
  const candidates: Array<{
    key: string;
    item: Item;
    receipt: any;
    index: number;
  }> = [];
  for (const key of Object.keys(ledger)) {
    const item = inventory.idToItem[key];
    if (!item || item.janCode !== jan) continue;
    ledger[key].forEach((entry: any, index: number) => {
      if (entry.kind !== "receipt") return;
      if (entry.ignored) return;
      if (entry.at < receivedAt) return;
      if (entry.source?.startsWith("stockOrder:")) return;
      if (entry.costOrderId) return;
      if (!(entry.qty > 0)) return;
      candidates.push({ key, item, receipt: entry, index });
    });
  }
  candidates.sort((a, b) => {
    if (a.receipt.at !== b.receipt.at) return a.receipt.at - b.receipt.at;
    if (a.receipt.seq !== b.receipt.seq) return a.receipt.seq - b.receipt.seq;
    if (a.key !== b.key) return a.key.localeCompare(b.key);
    return a.index - b.index;
  });
  const hit = candidates[0];
  if (!hit) return undefined;
  return {
    key: hit.key,
    item: hit.item,
    oldUnitJpy: hit.receipt.unitCostJpy,
    qty: hit.receipt.qty,
  };
}

function hasSourceTaggedStockOrderReceipt(
  inventory: Pick<InventoryState, "costLedger" | "idToItem">,
  orderId: string,
  jan: string,
): boolean {
  const ledgerByKey = inventory.costLedger || {};
  const source = `stockOrder:${orderId}`;
  for (const [key, ledger] of Object.entries(ledgerByKey)) {
    const item = inventory.idToItem[key];
    if (!item || item.janCode !== jan) continue;
    if (
      ledger.some(
        (entry) =>
          entry.kind === "receipt" && entry.source === source && entry.qty > 0,
      )
    )
      return true;
  }
  return false;
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
  weightToleranceG?: number;
  interpretation?: ManualInterpretation;
  inventory: Pick<
    InventoryState,
    "costLedger" | "idToItem" | "stockOrderRegistry"
  >;
}): StockOrderCostCommitPreview {
  const { rawPaste, orderId, overrideExisting, interpretation, inventory } =
    args;
  const weightToleranceG = Math.max(0, Number(args.weightToleranceG) || 0);
  const reg = inventory.stockOrderRegistry?.[orderId];
  const reconciliation = interpretation
    ? reconcileManual(
        buildInterpretation(rawPaste, interpretation),
        reg?.valueOfGoodsJpy,
        reg?.expectedItemCount,
      )
    : reconcileStockOrderCostTsv(
        parseStockOrderCostTsv(rawPaste),
        reg?.valueOfGoodsJpy,
        reg?.expectedItemCount,
      );
  // Stock orders have no subtypes: key by JAN only.
  const want = new Map<string, number>();
  for (const row of reconciliation.rows) want.set(row.jan, row.unitCostJpy);

  const ledger = inventory.costLedger || {};
  const matched: StockOrderCostCommitMatch[] = [];
  const matchedJans = new Set<string>();
  const affected: { key: string; oldCostJpy?: number; newCostJpy?: number }[] =
    [];
  const allocationCandidateByJan = new Map<
    string,
    { key: string; item: Item; oldUnitJpy: number; qty: number }
  >();
  const orderItemByJan = new Map<
    string,
    { key: string; item: Item; oldUnitJpy: number; qty: number }
  >();

  for (const key of Object.keys(ledger)) {
    const item = inventory.idToItem[key];
    if (!item) continue;
    const receipt = ledger[key].find((e) => lotMatchesOrder(e, orderId));
    if (!receipt || receipt.kind !== "receipt") continue;
    orderItemByJan.set(item.janCode, {
      key,
      item,
      oldUnitJpy: receipt.unitCostJpy,
      qty: receipt.qty,
    });
  }
  for (const row of reconciliation.rows) {
    if (orderItemByJan.has(row.jan) || allocationCandidateByJan.has(row.jan)) {
      continue;
    }
    const candidate = findZeroedAllocationCandidate(
      inventory,
      row.jan,
      reg?.receivedAt,
    );
    if (candidate) allocationCandidateByJan.set(row.jan, candidate);
  }

  for (const key of Object.keys(ledger)) {
    const item = inventory.idToItem[key];
    if (!item) continue;
    const orig = ledger[key];
    let anyChange = false;
    const projected = orig.map((e) => {
      if (!lotMatchesOrder(e, orderId) || e.kind !== "receipt") return e;
      const v = want.get(item.janCode);
      if (v == null) return e;
      matchedJans.add(item.janCode);
      const priced = e.unitCostJpy > 0;
      const isOverride = priced;
      if (priced && !overrideExisting) return e;
      matched.push({
        key,
        jan: item.janCode,
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
      (r) => !matchedJans.has(r.jan) && !allocationCandidateByJan.has(r.jan),
    )
    .map((r) => r.jan);

  const matchRows: StockOrderCostMatchRow[] = reconciliation.rows.map(
    (row, rowIndex) => {
      const hit =
        orderItemByJan.get(row.jan) || allocationCandidateByJan.get(row.jan);
      if (!hit) {
        return {
          rowIndex,
          jan: row.jan,
          qty: row.qty,
          unitCostJpy: row.unitCostJpy,
          lineCostJpy: row.unitCostJpy * row.qty,
          status: "Unmatched",
          kinds: ["unmatched"],
          isUnmatched: true,
          isOverride: false,
          costWillApply: false,
          incomingCountryOfOrigin: row.countryOfOrigin,
          incomingWeight: row.weight,
          canFixCountryOfOrigin: false,
          canFixWeight: false,
          countryOfOriginMismatch: false,
          weightMismatch: false,
        };
      }
      const isOverride = hit.oldUnitJpy > 0;
      const costWillApply = !isOverride || overrideExisting;
      const existingCoo = hit.item.countryOfOrigin?.trim();
      const incomingCoo = row.countryOfOrigin?.trim();
      const existingWeight = hit.item.weight;
      const incomingWeight = row.weight;
      const canFixCountryOfOrigin = !existingCoo && !!incomingCoo;
      const canFixWeight =
        !(existingWeight && existingWeight > 0) &&
        incomingWeight != null &&
        incomingWeight > 0;
      const countryOfOriginMismatch =
        !!existingCoo && !!incomingCoo && existingCoo !== incomingCoo;
      const weightMismatch =
        existingWeight != null &&
        existingWeight > 0 &&
        incomingWeight != null &&
        incomingWeight > 0 &&
        Math.abs(existingWeight - incomingWeight) > weightToleranceG;
      const kinds: StockOrderMatchKind[] = ["match"];
      if (!isOverride) kinds.push("fix cost");
      if (isOverride) kinds.push("override cost");
      if (canFixCountryOfOrigin) kinds.push("fix coo");
      if (canFixWeight) kinds.push("fix weight");
      if (countryOfOriginMismatch || weightMismatch) kinds.push("warning");
      return {
        rowIndex,
        jan: row.jan,
        qty: row.qty,
        unitCostJpy: row.unitCostJpy,
        lineCostJpy: row.unitCostJpy * row.qty,
        key: hit.key,
        item: {
          description: hit.item.description,
          image: hit.item.image,
          countryOfOrigin: hit.item.countryOfOrigin,
          weight: hit.item.weight,
          subtype: hit.item.subtype,
        },
        status: costWillApply
          ? isOverride
            ? "Override cost"
            : "Fix cost"
          : "Matched, existing cost",
        kinds,
        isUnmatched: false,
        isOverride,
        costWillApply,
        incomingCountryOfOrigin: incomingCoo,
        incomingWeight,
        canFixCountryOfOrigin,
        canFixWeight,
        countryOfOriginMismatch,
        weightMismatch,
      };
    },
  );

  return { reconciliation, matched, matchRows, unmatchedJans, affected };
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
  matchRows: StockOrderCostMatchRow[];
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
    interpretation?: ManualInterpretation;
    ignoreUnmatchedRows?: boolean;
    weightToleranceG?: number;
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
        weightToleranceG: opts.weightToleranceG,
        interpretation: opts.interpretation,
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
    for (const r of reconciliation.rows) want.set(r.jan, r.unitCostJpy);

  const tag = `stockOrder:${orderId}`;
  const ledger = inventory.costLedger || {};
  const projectedByKey = new Map<string, LedgerEntry[]>();
  const touchedKeys = new Set<string>();
  let affectedLots = 0;

  for (const key of Object.keys(ledger)) {
    const orig = ledger[key];
    const item = inventory.idToItem[key];
    const projected = orig.map((e) => {
      const entry = { ...e } as LedgerEntry;
      if (!lotMatchesOrder(entry, orderId) || entry.kind !== "receipt")
        return entry;
      affectedLots++;
      touchedKeys.add(key);
      const fromThisOrder = entry.source === tag;
      let unitCostJpy = entry.unitCostJpy;
      if (item) {
        const v = want.get(item.janCode);
        if (v != null && (!(entry.unitCostJpy > 0) || opts.overrideExisting))
          unitCostJpy = v;
      }
      const unitCostEur = fx > 0 ? unitCostJpy * fx : entry.unitCostEur;
      return {
        ...entry,
        // Scan-attached lots keep their scan date; only lots the
        // order created get re-dated.
        at: fromThisOrder ? (receivedAt ?? entry.at) : entry.at,
        unitCostJpy,
        unitCostEur,
      };
    }) as LedgerEntry[];
    projectedByKey.set(key, projected);
  }

  if (reconciliation && receivedAt) {
    for (const row of reconciliation.rows) {
      if (!(Number(row.qty) > 0)) continue;
      if (hasSourceTaggedStockOrderReceipt(inventory, orderId, row.jan))
        continue;
      const queues = Object.entries(inventory.idToItem)
        .filter(([, item]) => item.janCode === row.jan)
        .map(([key]) => {
          const projected =
            projectedByKey.get(key) ||
            ((ledger[key] || []).map((e) => ({ ...e })) as LedgerEntry[]);
          projectedByKey.set(key, projected);
          const candidates = projected
            .map((entry, index) => ({ entry, index }))
            .filter(({ entry }) => {
              if (entry.kind !== "receipt") return false;
              if (entry.ignored) return false;
              if (entry.at < receivedAt) return false;
              if (entry.source?.startsWith("stockOrder:")) return false;
              if (entry.costOrderId) return false;
              return entry.qty > 0;
            })
            .sort((a, b) => {
              if (a.entry.at !== b.entry.at) return a.entry.at - b.entry.at;
              if (a.entry.seq !== b.entry.seq) return a.entry.seq - b.entry.seq;
              return a.index - b.index;
            });
          return { key, candidates };
        })
        .filter((queue) => queue.candidates.length > 0);

      let remaining = row.qty;
      while (remaining > 0) {
        let consumedAny = false;
        for (const queue of queues) {
          if (remaining <= 0) break;
          const next = queue.candidates.shift();
          if (!next) continue;
          const receipt = next.entry as ReceiptEntry;
          receipt.costOrderId = orderId;
          receipt.unitCostJpy = row.unitCostJpy;
          receipt.unitCostEur =
            fx > 0 ? row.unitCostJpy * fx : receipt.unitCostEur;
          if (receipt.qty > remaining) receipt.auditSeverity = "danger";
          remaining -= receipt.qty;
          affectedLots++;
          touchedKeys.add(queue.key);
          consumedAny = true;
        }
        if (!consumedAny) break;
      }
    }
  }

  const items: StockOrderFixItem[] = [...touchedKeys].map((key) => {
    const before = walkLedger(ledger[key] || []);
    const after = walkLedger(projectedByKey.get(key) || ledger[key] || []);
    return {
      key,
      oldCostJpy: before.avgJpy,
      newCostJpy: after.avgJpy,
      oldCostEur: before.avgEur,
      newCostEur: after.avgEur,
    };
  });
  items.sort((a, b) => a.key.localeCompare(b.key));

  const blocked =
    !!reconciliation &&
    (!reconciliation.chosen ||
      reconciliation.rows.length === 0 ||
      (!reconciliation.reconciled &&
        reconciliation.discrepancy != null &&
        !opts.approveDiscrepancy) ||
      (reconciliation.itemCountDiscrepancy != null &&
        reconciliation.itemCountDiscrepancy !== 0 &&
        !opts.approveDiscrepancy) ||
      (!!cost && cost.unmatchedJans.length > 0 && !opts.ignoreUnmatchedRows) ||
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
    matchRows: cost?.matchRows ?? [],
    unmatchedJans: cost?.unmatchedJans ?? [],
    blocked,
  };
}
