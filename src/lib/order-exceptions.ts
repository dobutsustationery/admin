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
import { toTimestampMs } from "./timestamped-action";
import {
  parseStockOrderCostTsv,
  reconcileStockOrderCostTsv,
  buildInterpretation,
  reconcileManual,
  type StockOrderCostReconciliation,
  type StockOrderCostRow,
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
  usesZeroedQuantities?: boolean;
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
      usesZeroedQuantities: m.usesZeroedQuantities,
      lotCount,
      unpricedCount,
      flags,
      isException: Object.values(flags).some(Boolean),
    });
  }
  rows.sort((a, b) => {
    const aDate = a.receivedAt && a.receivedAt > 0 ? a.receivedAt : Infinity;
    const bDate = b.receivedAt && b.receivedAt > 0 ? b.receivedAt : Infinity;
    if (aDate !== bDate) return aDate - bDate;
    return a.name.localeCompare(b.name);
  });
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

export interface StockOrderScanBatchScan {
  actionId: string;
  at: number;
  rawJan: string;
  jan: string;
  itemKey: string;
  qty: number;
  description: string;
}

export interface StockOrderScanBatchExpectedRow {
  jan: string;
  rows: number[];
  expectedQty: number;
  scannedQty: number;
  gap: number;
  unitCosts: number[];
  scans: StockOrderScanBatchScan[];
}

export interface StockOrderScanBatchExtraRow {
  jan: string;
  scannedQty: number;
  scans: StockOrderScanBatchScan[];
}

export interface StockOrderScanBatchAuditRow {
  orderId: string;
  name: string;
  startAt?: number;
  endAt?: number;
  expectedUniqueJans: number;
  expectedRows: number;
  expectedQty: number;
  scannedUniqueOrderJans: number;
  scannedOrderQty: number;
  scanCount: number;
  missingOrShort: StockOrderScanBatchExpectedRow[];
  overScanned: StockOrderScanBatchExpectedRow[];
  extraScans: StockOrderScanBatchExtraRow[];
  unusualCount: number;
}

export interface StockOrderUnmatchedScanDaySummary {
  date: string;
  at: number;
  unmatchedScanCount: number;
  matchedScanCount: number;
  unmatchedQty: number;
  matchedQty: number;
  unmatchedUniqueJans: number;
  unmatchedJans: string[];
}

export interface StockOrderScannerAuditResult {
  rows: StockOrderScanBatchAuditRow[];
  unmatchedScanDays: StockOrderUnmatchedScanDaySummary[];
}

const SCAN_BATCH_WINDOW_DAYS = 7;

function normalizeJan(value: unknown): string {
  return String(value || "").trim();
}

function timestampSortKey(action: any): number {
  const ms =
    toTimestampMs(action?.timestamp) ??
    (typeof action?._timestamp_millis === "number"
      ? action._timestamp_millis
      : typeof action?._timestamp === "number"
        ? action._timestamp
        : 0);
  const nanos =
    typeof action?.timestamp?.nanoseconds === "number"
      ? action.timestamp.nanoseconds / 1_000_000
      : typeof action?.timestamp?._nanoseconds === "number"
        ? action.timestamp._nanoseconds / 1_000_000
        : 0;
  return ms + nanos / 1000;
}

function dayStartUtc(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function orderScanBatchScans(
  actions: readonly any[],
): StockOrderScanBatchScan[] {
  return actions
    .filter((action) => action?.type === "update_item")
    .map((action, index) => {
      const payload = action.payload || {};
      const item = payload.item || {};
      const rawJan = String(item.janCode || payload.id || "");
      return {
        actionId: String(action.id || `scan:${index}`),
        at: timestampSortKey(action),
        rawJan,
        jan: normalizeJan(rawJan),
        itemKey: String(payload.id || ""),
        qty: Number(item.qty) || 0,
        description: String(item.description || ""),
      };
    })
    .filter((scan) => scan.at > 0 && scan.jan)
    .sort((a, b) => a.at - b.at || a.actionId.localeCompare(b.actionId));
}

function expectedRowsForOrder(
  rows: readonly { jan: string; unitCostJpy: number; qty?: number }[],
) {
  const expected = new Map<
    string,
    {
      jan: string;
      rows: number[];
      expectedQty: number;
      unitCosts: Set<number>;
    }
  >();
  rows.forEach((row, index) => {
    const jan = normalizeJan(row.jan);
    const qty = Number(row.qty) || 0;
    if (!jan || !(qty > 0)) return;
    const entry = expected.get(jan) || {
      jan,
      rows: [],
      expectedQty: 0,
      unitCosts: new Set<number>(),
    };
    entry.rows.push(index + 1);
    entry.expectedQty += qty;
    if (Number(row.unitCostJpy) > 0) entry.unitCosts.add(row.unitCostJpy);
    expected.set(jan, entry);
  });
  return expected;
}

function chooseBestScanWindow(
  expectedJans: Set<string>,
  scans: readonly StockOrderScanBatchScan[],
): { startAt?: number; endAt?: number; scans: StockOrderScanBatchScan[] } {
  const matchingScans = scans.filter((scan) => expectedJans.has(scan.jan));
  const candidateStarts = [
    ...new Set(matchingScans.map((scan) => dayStartUtc(scan.at))),
  ].sort((a, b) => a - b);
  if (candidateStarts.length === 0) return { scans: [] };

  let best = {
    startAt: candidateStarts[0],
    endAt: candidateStarts[0] + SCAN_BATCH_WINDOW_DAYS * 86_400_000,
    scans: [] as StockOrderScanBatchScan[],
    score: -1,
    uniqueMatches: -1,
    matchedQty: -1,
    extraUnique: Number.MAX_SAFE_INTEGER,
    precision: 0,
  };

  for (const startAt of candidateStarts) {
    const endAt = startAt + SCAN_BATCH_WINDOW_DAYS * 86_400_000;
    const windowScans = scans.filter(
      (scan) => scan.at >= startAt && scan.at < endAt,
    );
    const matched = windowScans.filter((scan) => expectedJans.has(scan.jan));
    const uniqueMatches = new Set(matched.map((scan) => scan.jan)).size;
    const extraUnique = new Set(
      windowScans
        .filter((scan) => !expectedJans.has(scan.jan))
        .map((scan) => scan.jan),
    ).size;
    const matchedQty = matched.reduce((sum, scan) => sum + scan.qty, 0);
    const precision =
      uniqueMatches + extraUnique > 0
        ? uniqueMatches / (uniqueMatches + extraUnique)
        : 0;
    const recall =
      expectedJans.size > 0 ? uniqueMatches / expectedJans.size : 0;
    const score =
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0;
    const uniqueGain = uniqueMatches - best.uniqueMatches;
    const meaningfulUniqueGain =
      uniqueGain > 0 &&
      (best.uniqueMatches < 0 ||
        precision >= best.precision * 0.75 ||
        uniqueGain >= Math.max(3, best.uniqueMatches * 0.25));
    const isBetter =
      meaningfulUniqueGain ||
      (uniqueMatches === best.uniqueMatches &&
        extraUnique < best.extraUnique) ||
      (uniqueMatches === best.uniqueMatches &&
        extraUnique === best.extraUnique &&
        score > best.score) ||
      (uniqueMatches === best.uniqueMatches &&
        score === best.score &&
        extraUnique === best.extraUnique &&
        matchedQty > best.matchedQty);
    if (isBetter) {
      best = {
        startAt,
        endAt,
        scans: windowScans,
        score,
        uniqueMatches,
        matchedQty,
        extraUnique,
        precision,
      };
    }
  }

  return { startAt: best.startAt, endAt: best.endAt, scans: best.scans };
}

function buildUnmatchedScanDaySummaries(
  scans: readonly StockOrderScanBatchScan[],
  matchedScanIds: ReadonlySet<string>,
): StockOrderUnmatchedScanDaySummary[] {
  const byDate = new Map<
    string,
    {
      date: string;
      at: number;
      unmatchedScanCount: number;
      matchedScanCount: number;
      unmatchedQty: number;
      matchedQty: number;
      unmatchedJans: Set<string>;
    }
  >();

  for (const scan of scans) {
    const at = dayStartUtc(scan.at);
    const date = new Date(at).toISOString().slice(0, 10);
    const row =
      byDate.get(date) ||
      ({
        date,
        at,
        unmatchedScanCount: 0,
        matchedScanCount: 0,
        unmatchedQty: 0,
        matchedQty: 0,
        unmatchedJans: new Set<string>(),
      } satisfies {
        date: string;
        at: number;
        unmatchedScanCount: number;
        matchedScanCount: number;
        unmatchedQty: number;
        matchedQty: number;
        unmatchedJans: Set<string>;
      });
    if (matchedScanIds.has(scan.actionId)) {
      row.matchedScanCount += 1;
      row.matchedQty += scan.qty;
    } else {
      row.unmatchedScanCount += 1;
      row.unmatchedQty += scan.qty;
      row.unmatchedJans.add(scan.jan);
    }
    byDate.set(date, row);
  }

  return [...byDate.values()]
    .filter((row) => row.unmatchedScanCount > 0)
    .map((row) => {
      const unmatchedJans = [...row.unmatchedJans].sort();
      return {
        date: row.date,
        at: row.at,
        unmatchedScanCount: row.unmatchedScanCount,
        matchedScanCount: row.matchedScanCount,
        unmatchedQty: row.unmatchedQty,
        matchedQty: row.matchedQty,
        unmatchedUniqueJans: unmatchedJans.length,
        unmatchedJans,
      };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * Compare each stock order's cost rows to the most likely scanner batch
 * containing them. This intentionally uses raw replayed broadcast actions:
 * reducer state alone can no longer distinguish duplicate scanner snapshots
 * that collapsed into one final item.
 */
export function buildStockOrderScannerAudit(
  inventory: Pick<InventoryState, "stockOrderRegistry">,
  actions: readonly any[],
): StockOrderScannerAuditResult {
  const registry = inventory.stockOrderRegistry || {};
  const scans = orderScanBatchScans(actions);
  const rows: StockOrderScanBatchAuditRow[] = [];
  const matchedScanIds = new Set<string>();

  for (const [orderId, meta] of Object.entries(registry)) {
    if (meta.usesZeroedQuantities !== true) continue;
    const costRows = meta.costRows || [];
    const expected = expectedRowsForOrder(costRows);
    if (expected.size === 0) continue;

    const expectedJans = new Set(expected.keys());
    const batch = chooseBestScanWindow(expectedJans, scans);
    const scanByJan = new Map<string, StockOrderScanBatchScan[]>();
    for (const scan of batch.scans) {
      if (expectedJans.has(scan.jan)) matchedScanIds.add(scan.actionId);
      const existing = scanByJan.get(scan.jan) || [];
      existing.push(scan);
      scanByJan.set(scan.jan, existing);
    }

    const expectedRows: StockOrderScanBatchExpectedRow[] = [
      ...expected.values(),
    ]
      .map((entry) => {
        const janScans = scanByJan.get(entry.jan) || [];
        const scannedQty = janScans.reduce((sum, scan) => sum + scan.qty, 0);
        return {
          jan: entry.jan,
          rows: entry.rows,
          expectedQty: entry.expectedQty,
          scannedQty,
          gap: entry.expectedQty - scannedQty,
          unitCosts: [...entry.unitCosts].sort((a, b) => a - b),
          scans: janScans,
        };
      })
      .sort((a, b) => a.rows[0] - b.rows[0]);

    const missingOrShort = expectedRows.filter((row) => row.gap > 0);
    const overScanned = expectedRows.filter((row) => row.gap < 0);
    const extraScans = [...scanByJan.entries()]
      .filter(([jan]) => !expectedJans.has(jan))
      .map(([jan, janScans]) => ({
        jan,
        scannedQty: janScans.reduce((sum, scan) => sum + scan.qty, 0),
        scans: janScans,
      }))
      .sort((a, b) => a.scans[0].at - b.scans[0].at);
    const scannedUniqueOrderJans = expectedRows.filter(
      (row) => row.scannedQty > 0,
    ).length;
    const scannedOrderQty = expectedRows.reduce(
      (sum, row) => sum + row.scannedQty,
      0,
    );

    rows.push({
      orderId,
      name: meta.name || orderId,
      startAt: batch.startAt,
      endAt: batch.endAt,
      expectedUniqueJans: expected.size,
      expectedRows: costRows.length,
      expectedQty: expectedRows.reduce((sum, row) => sum + row.expectedQty, 0),
      scannedUniqueOrderJans,
      scannedOrderQty,
      scanCount: batch.scans.length,
      missingOrShort,
      overScanned,
      extraScans,
      unusualCount:
        missingOrShort.length + overScanned.length + extraScans.length,
    });
  }

  rows.sort((a, b) => {
    if ((b.unusualCount > 0 ? 1 : 0) !== (a.unusualCount > 0 ? 1 : 0)) {
      return (b.unusualCount > 0 ? 1 : 0) - (a.unusualCount > 0 ? 1 : 0);
    }
    const aStart = a.startAt || Number.MAX_SAFE_INTEGER;
    const bStart = b.startAt || Number.MAX_SAFE_INTEGER;
    if (aStart !== bStart) return aStart - bStart;
    return a.name.localeCompare(b.name);
  });
  return {
    rows,
    unmatchedScanDays: buildUnmatchedScanDaySummaries(scans, matchedScanIds),
  };
}

export function buildStockOrderScanBatchAudit(
  inventory: Pick<InventoryState, "stockOrderRegistry">,
  actions: readonly any[],
): StockOrderScanBatchAuditRow[] {
  return buildStockOrderScannerAudit(inventory, actions).rows;
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

function aggregateStockOrderAllocationRows(
  rows: readonly StockOrderCostRow[],
): StockOrderCostRow[] {
  const aggregated = new Map<string, StockOrderCostRow>();
  for (const row of rows) {
    const qty = Number(row.qty);
    if (!(qty > 0)) continue;
    const unitCostJpy = Number(row.unitCostJpy);
    const key = `${row.jan}|${unitCostJpy}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.qty += qty;
    } else {
      aggregated.set(key, { ...row, qty, unitCostJpy });
    }
  }
  return [...aggregated.values()];
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

  const matchRows: StockOrderCostMatchRow[] = [];
  reconciliation.rows.forEach((row, rowIndex) => {
    const costHit =
      orderItemByJan.get(row.jan) || allocationCandidateByJan.get(row.jan);
    const itemHits = Object.entries(inventory.idToItem)
      .filter(([, item]) => item.janCode === row.jan)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => ({ key, item }));

    if (!costHit && itemHits.length === 0) {
      matchRows.push({
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
      });
      return;
    }

    const costIsOverride = !!costHit && costHit.oldUnitJpy > 0;
    const costWillApply = !!costHit && (!costIsOverride || overrideExisting);
    for (const hit of itemHits) {
      const isCostTarget = costHit?.key === hit.key;
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
      if (isCostTarget && !costIsOverride) kinds.push("fix cost");
      if (isCostTarget && costIsOverride) kinds.push("override cost");
      if (canFixCountryOfOrigin) kinds.push("fix coo");
      if (canFixWeight) kinds.push("fix weight");
      if (countryOfOriginMismatch || weightMismatch) kinds.push("warning");
      matchRows.push({
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
        status: isCostTarget
          ? costWillApply
            ? costIsOverride
              ? "Override cost"
              : "Fix cost"
            : "Matched, existing cost"
          : "Metadata match",
        kinds,
        isUnmatched: false,
        isOverride: isCostTarget && costIsOverride,
        costWillApply: isCostTarget && costWillApply,
        incomingCountryOfOrigin: incomingCoo,
        incomingWeight,
        canFixCountryOfOrigin,
        canFixWeight,
        countryOfOriginMismatch,
        weightMismatch,
      });
    }
  });

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
    for (const row of aggregateStockOrderAllocationRows(reconciliation.rows)) {
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
