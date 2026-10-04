import { createAction } from "@reduxjs/toolkit";
import type { CustomsReport } from "./customs-summary-model";
import { computeCustoms } from "./customs-summary-compute";
import type {
  InventoryState,
  BulkImportItem,
  StockOrderMeta,
} from "./inventory";
import { BGN_PER_EUR } from "./cost-engine";
import { makeInventoryItemKey } from "./sku";
import {
  parseStockOrderCostTsv,
  reconcileStockOrderCostTsv,
  buildInterpretation,
  reconcileManual,
} from "./stock-order-cost-tsv";

export interface ReceiptAllocation {
  destination: "inventory" | "asset";
  itemKey: string;
  subtype: string;
  qty: string;
}
export interface ReceiptDecision {
  received: string;
  rejected: string;
  note: string;
  allocations: ReceiptAllocation[];
}
export interface ReceiptFacts {
  date: string;
  goodsJpy: string;
  invoiceJpy: string;
  expectedPieces: string;
  paidAmount: string;
  paidCurrency: "EUR" | "BGN";
  shippedDate: string;
  shippingAmount: string;
  shippingCurrency: "JPY" | "EUR" | "BGN";
  shippingIncluded: boolean;
  costTsv: string;
  stockNotEntered: boolean;
  unitsConfirmed?: boolean;
  costInterpretation?: {
    kind: "unit" | "total";
    costColumnIndex: number;
    qtyColumnIndex: number;
  };
}
export interface ReceiptRow {
  jan: string;
  description: string;
  expected: number;
  code: string;
  unitJpy: number;
  received: number;
  rejected: number;
  accepted: number;
  missing: number;
  confirmed: boolean;
  matches: { id: string; subtype: string; available: number }[];
  defaultDecision: ReceiptDecision;
}
export interface AssetAcceptance {
  jan: string;
  description: string;
  qty: number;
  unitJpy: number;
  unitEur: number;
  date: string;
  note: string;
}
export interface ReceiptProjection {
  rows: ReceiptRow[];
  costColumns: { index: number; label: string }[];
  issues: string[];
  expected: number;
  received: number;
  rejected: number;
  accepted: number;
  inventoryQty: number;
  assetQty: number;
  acceptedJpy: number;
  acceptedEur: number;
  fx: number;
  updates: BulkImportItem[];
  stock: { key: string; added: number; before: number; after: number }[];
  assets: AssetAcceptance[];
  meta: StockOrderMeta;
}
export interface OrderReceipt {
  id: string;
  reportId: string;
  sourceRevision: number;
  source: CustomsReport;
  revision: number;
  decisions: Record<string, ReceiptDecision>;
  facts: ReceiptFacts;
  completed?: { eventId: string; at: number };
  projection: ReceiptProjection;
}
export interface ReceiptsState {
  orders: Record<string, OrderReceipt>;
  results: Record<string, string>;
}
export const initialReceipts: ReceiptsState = { orders: {}, results: {} };
export const orderReceipts = (state: ReceiptsState = initialReceipts) => state;
export const receiptStart = createAction<{
  reportId: string;
  reportRevision: number;
}>("receipts/start");
type Edit = { orderId: string; revision: number };
export const receiptLine = createAction<
  Edit & { jan: string; decision: ReceiptDecision }
>("receipts/line");
export const receiptConfirm = createAction<Edit & { jans: string[] }>(
  "receipts/confirmCorrect",
);
export const receiptFacts = createAction<Edit & { facts: ReceiptFacts }>(
  "receipts/facts",
);
export const receiptRefresh = createAction<
  Edit & { reportId: string; reportRevision: number }
>("receipts/refresh");
export const receiptComplete = createAction<Edit>("receipts/complete");
export const receiptOrderId = (r: CustomsReport) =>
  r.input ? `receipt:${r.input.order.id}:${r.projection.invoice}` : "";

const number = (s: unknown) =>
  typeof s === "string" && !s.trim() ? NaN : Number(s);
const count = (s: unknown) => Number.isSafeInteger(number(s)) && number(s) >= 0;
const positive = (s: unknown) => Number.isFinite(number(s)) && number(s) > 0;
const dateMs = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
  const ms = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s
    ? ms
    : NaN;
};
export function projectReceipt(
  r: OrderReceipt,
  inventory: InventoryState,
  current?: CustomsReport,
): ReceiptProjection {
  const source = computeCustoms(r.source);
  const issues: string[] = [];
  const f = r.facts;
  if (!current || current.abandoned || current.revision !== r.sourceRevision)
    issues.push(
      "The customs report changed or was abandoned. Refresh the source and review the receipt again.",
    );
  if (inventory.stockOrderRegistry?.[r.source.input!.order.id])
    issues.push(
      "This source file is already registered through Order Import. Review its history before receiving it again.",
    );
  if (!source.invoice || !source.products.length)
    issues.push("The source has no valid invoice/products.");
  // Customs-only weight/package requirements do not block receiving.
  issues.push(
    ...source.issues.filter(
      (s) =>
        !/accept\/enter an eight-digit|Save measurements|Provide measured gross|Confirm the package convention/.test(
          s,
        ),
    ),
  );
  if (!Number.isFinite(dateMs(f.date)))
    issues.push("Enter the actual receipt date.");
  if (f.shippedDate && !Number.isFinite(dateMs(f.shippedDate)))
    issues.push("Enter a valid shipping date.");
  if (f.shippedDate && dateMs(f.shippedDate) > dateMs(f.date))
    issues.push("Shipping date cannot follow receipt date.");
  if (
    !positive(f.goodsJpy) ||
    !positive(f.invoiceJpy) ||
    number(f.invoiceJpy) < number(f.goodsJpy)
  )
    issues.push(
      "Enter goods and invoice values in JPY; invoice total must cover goods.",
    );
  if (!positive(f.paidAmount) || !["EUR", "BGN"].includes(f.paidCurrency))
    issues.push("Enter the actual payment in EUR or BGN.");
  if (
    !count(f.expectedPieces) ||
    number(f.expectedPieces) !== source.totals.pieces
  )
    issues.push("Expected piece count must match the source.");
  if (
    !Number.isFinite(number(f.shippingAmount)) ||
    number(f.shippingAmount) < 0 ||
    !["JPY", "EUR", "BGN"].includes(f.shippingCurrency)
  )
    issues.push("Enter shipping cost (zero if none) and its currency.");
  if (
    f.shippingIncluded &&
    f.shippingCurrency === "JPY" &&
    number(f.shippingAmount) > number(f.invoiceJpy) - number(f.goodsJpy) + 0.01
  )
    issues.push("Included shipping exceeds the invoice's non-goods amount.");
  if (!f.unitsConfirmed)
    issues.push(
      "Confirm that source pieces match the inventory selling units.",
    );
  if (!f.stockNotEntered)
    issues.push(
      "Confirm that this delivery has not already been entered into stock.",
    );
  const paidEur =
    number(f.paidAmount) / (f.paidCurrency === "BGN" ? BGN_PER_EUR : 1);
  const fx =
    positive(f.paidAmount) && positive(f.invoiceJpy)
      ? paidEur / number(f.invoiceJpy)
      : 0;
  let costs = new Map(source.products.map((p) => [p.jan, p.price]));
  const parsedCosts = parseStockOrderCostTsv(f.costTsv);
  if (f.costTsv.trim()) {
    const reconciliation = f.costInterpretation
      ? reconcileManual(
          buildInterpretation(f.costTsv, f.costInterpretation),
          number(f.goodsJpy),
          number(f.expectedPieces),
        )
      : reconcileStockOrderCostTsv(
          parsedCosts,
          number(f.goodsJpy),
          number(f.expectedPieces),
        );
    if (
      !reconciliation.chosen ||
      !reconciliation.reconciled ||
      reconciliation.itemCountDiscrepancy !== 0
    )
      issues.push(
        "The pasted invoice costs must reconcile to goods value and expected pieces.",
      );
    const totals = new Map<string, { qty: number; yen: number }>();
    for (const row of reconciliation.rows) {
      const prev = totals.get(row.jan) || { qty: 0, yen: 0 };
      totals.set(row.jan, {
        qty: prev.qty + row.qty,
        yen: prev.yen + row.qty * row.unitCostJpy,
      });
    }
    costs = new Map(
      [...totals].map(([jan, t]) => [jan, t.qty ? t.yen / t.qty : 0]),
    );
    if (
      [...totals.keys()].some(
        (jan) => !source.products.some((p) => p.jan === jan),
      ) ||
      source.products.some((p) => totals.get(p.jan)?.qty !== p.qty)
    )
      issues.push(
        "Pasted cost rows must match each source JAN and expected quantity.",
      );
  }
  const sourceValue = source.products.reduce(
    (sum, p) => sum + p.qty * (costs.get(p.jan) || 0),
    0,
  );
  if (
    !positive(f.goodsJpy) ||
    Math.abs(sourceValue - number(f.goodsJpy)) > 0.01
  )
    issues.push(
      "Goods value must reconcile to original quantities × reviewed unit costs.",
    );
  const updates: BulkImportItem[] = [];
  const assets: AssetAcceptance[] = [];
  const seenKeys = new Set<string>();
  let received = 0,
    rejected = 0,
    accepted = 0,
    inventoryQty = 0,
    assetQty = 0,
    acceptedJpy = 0;
  const rows = source.products.map((p) => {
    const matches = Object.entries(inventory.idToItem)
      .filter(([, i]) => i.janCode === p.jan)
      .map(([id, i]) => ({
        id,
        subtype: i.subtype || "",
        available: i.qty - (i.shipped || 0),
      }));
    const defaultDecision: ReceiptDecision = {
      received: String(p.qty),
      rejected: "0",
      note: "",
      allocations: [
        {
          destination: "inventory",
          itemKey: matches.length === 1 ? matches[0].id : "",
          subtype: "",
          qty: String(p.qty),
        },
      ],
    };
    const d = r.decisions[p.jan];
    const unitJpy = costs.get(p.jan) || 0;
    const actual = d && count(d.received) ? number(d.received) : 0;
    const bad = d && count(d.rejected) ? number(d.rejected) : 0;
    const good = Math.max(0, actual - bad);
    const err = (s: string) => issues.push(`${p.jan}: ${s}`);
    if (!d) err("confirm count and quality.");
    else {
      if (!count(d.received) || !count(d.rejected) || bad > actual)
        err(
          "enter whole received/rejected quantities with rejected ≤ received.",
        );
      if ((actual !== p.qty || bad > 0) && !d.note.trim())
        err("explain the shortage, over-delivery or rejected goods.");
      if (
        !Array.isArray(d.allocations) ||
        d.allocations.some((a) => !count(a.qty)) ||
        d.allocations.reduce((s, a) => s + number(a.qty), 0) !== good
      )
        err("destination allocations must equal accepted quantity.");
      for (const a of d.allocations || []) {
        const qty = number(a.qty);
        if (!(qty > 0) || !count(a.qty)) continue;
        if (a.destination === "asset") {
          assets.push({
            jan: p.jan,
            description: p.description,
            qty,
            unitJpy,
            unitEur: unitJpy * fx,
            date: f.date,
            note: d.note,
          });
          assetQty += qty;
        } else if (a.destination === "inventory") {
          const key =
            a.itemKey || makeInventoryItemKey(p.jan, a.subtype.trim());
          const existing = inventory.idToItem[key];
          if (a.itemKey && (!existing || existing.janCode !== p.jan)) {
            err(
              "selected inventory identity is missing or belongs to another JAN.",
            );
            continue;
          }
          if (!a.itemKey && existing) {
            err("new subtype already exists; choose that existing item.");
            continue;
          }
          if (!a.itemKey && matches.length && !a.subtype.trim()) {
            err("choose the exact existing variant or name a new subtype.");
            continue;
          }
          if (existing && Number(existing.pieces || 1) !== 1) {
            err(
              "existing item uses packs/loose pieces; resolve the inventory unit before receiving.",
            );
            continue;
          }
          if (!/^\d{8}$/.test(p.code)) {
            err("resolve its HS code in the customs report.");
            continue;
          }
          if (seenKeys.has(key)) {
            err("combine duplicate allocations to the same inventory item.");
            continue;
          }
          seenKeys.add(key);
          updates.push({
            type: existing ? "update" : "new",
            id: key,
            item: {
              janCode: p.jan,
              subtype: existing?.subtype || a.subtype.trim(),
              description: existing?.description || p.description,
              hsCode: existing?.hsCode || p.code,
              image: existing?.image || "",
              qty,
              pieces: 1,
              cost: unitJpy,
              weight: existing?.weight || p.grams,
              countryOfOrigin: existing?.countryOfOrigin || p.origin,
            } as any,
            stockOrder: { orderId: r.id, orderedQty: qty },
          });
          inventoryQty += qty;
        } else err("choose an inventory or company-use destination.");
      }
    }
    if (good > 0 && !(unitJpy > 0 && Number.isFinite(unitJpy)))
      err("a positive reviewed unit cost is required.");
    received += actual;
    rejected += bad;
    accepted += good;
    acceptedJpy += good * unitJpy;
    return {
      jan: p.jan,
      description: p.description,
      expected: p.qty,
      code: p.code,
      unitJpy,
      received: actual,
      rejected: bad,
      accepted: good,
      missing: Math.max(0, p.qty - actual),
      confirmed: !!d,
      matches,
      defaultDecision,
    };
  });
  return {
    rows,
    costColumns: parsedCosts.columns,
    issues: [...new Set(issues)],
    expected: source.totals.pieces,
    received,
    rejected,
    accepted,
    inventoryQty,
    assetQty,
    acceptedJpy,
    acceptedEur: acceptedJpy * fx,
    fx,
    updates,
    stock: updates.map((u) => ({
      key: String(u.id),
      added: u.item.qty,
      before:
        (inventory.idToItem[u.id]?.qty || 0) -
        (inventory.idToItem[u.id]?.shipped || 0),
      after:
        (inventory.idToItem[u.id]?.qty || 0) -
        (inventory.idToItem[u.id]?.shipped || 0) +
        u.item.qty,
    })),
    assets,
    meta: {
      name: r.source.name,
      receivedAt: dateMs(f.date),
      valueOfGoodsJpy: number(f.goodsJpy),
      valueOfOrderJpy: number(f.invoiceJpy),
      paidAmount: number(f.paidAmount),
      paidCurrency: f.paidCurrency,
      expectedItemCount: number(f.expectedPieces),
      usesZeroedQuantities: false,
    },
  };
}

export function reduceReceipts(
  state: ReceiptsState = initialReceipts,
  action: any,
  reports: Record<string, CustomsReport>,
  inventory: InventoryState,
): { state: ReceiptsState; posting?: OrderReceipt } {
  if (action.type.startsWith("receipts/") && (!action.id || !action._timestamp))
    return { state };
  let orders = { ...state.orders };
  let error = "";
  let posting: OrderReceipt | undefined;
  const p = action.payload || {};
  if (receiptStart.match(action)) {
    const report = reports[p.reportId];
    if (
      !report?.input ||
      report.abandoned ||
      report.revision !== p.reportRevision ||
      !report.projection.invoice
    )
      error = "Choose a current, active customs report with source data.";
    else {
      const id = receiptOrderId(report);
      if (!orders[id])
        orders[id] = {
          id,
          reportId: report.id,
          sourceRevision: report.revision,
          source: report,
          revision: 0,
          decisions: {},
          facts: {
            date: "",
            goodsJpy: String(report.projection.totals.yen),
            invoiceJpy: "",
            expectedPieces: String(report.projection.totals.pieces),
            paidAmount: "",
            paidCurrency: "EUR",
            shippedDate: "",
            shippingAmount: "",
            shippingCurrency: "JPY",
            shippingIncluded: true,
            costTsv: "",
            stockNotEntered: false,
          },
          projection: null as any,
        };
    }
  } else if (action.type.startsWith("receipts/")) {
    const existing = orders[p.orderId];
    if (!existing) error = "Receipt not found.";
    else if (existing.completed) {
      if (!receiptComplete.match(action))
        error = "This receipt is complete and cannot be edited.";
    } else if (p.revision !== existing.revision)
      error =
        "The receipt changed in another tab. Reload the saved review before editing.";
    else {
      let r = { ...existing, decisions: { ...existing.decisions } };
      if (receiptLine.match(action)) {
        if (!r.projection.rows.some((row) => row.jan === p.jan))
          error = "Source product not found.";
        else r.decisions[p.jan] = p.decision;
      } else if (receiptConfirm.match(action)) {
        for (const jan of p.jans) {
          const row = r.projection.rows.find((row) => row.jan === jan);
          if (!row || row.matches.length > 1) {
            error = "Review ambiguous variants individually.";
            break;
          }
          r.decisions[jan] = row.defaultDecision;
        }
      } else if (receiptFacts.match(action)) r.facts = p.facts;
      else if (receiptRefresh.match(action)) {
        const report = reports[p.reportId];
        if (
          !report?.input ||
          report.abandoned ||
          report.revision !== p.reportRevision ||
          receiptOrderId(report) !== r.id
        )
          error = "Choose the current customs report for this order.";
        else
          r = {
            ...r,
            reportId: report.id,
            sourceRevision: report.revision,
            source: report,
            decisions: {},
          };
      } else if (receiptComplete.match(action)) {
        r.projection = projectReceipt(r, inventory, reports[r.reportId]);
        if (r.projection.issues.length) error = r.projection.issues.join("\n");
        else if (!(action as any).id || !(action as any)._timestamp)
          error = "Receipt completion requires a persisted event.";
        else {
          r.completed = {
            eventId: (action as any).id,
            at: (action as any)._timestamp,
          };
          posting = r;
        }
      } else error = "Unknown receipt action.";
      if (!error) {
        r.revision++;
        orders[r.id] = r;
      }
    }
  }
  // Inventory changes and customs edits revalidate open receipts as well.
  for (const [id, r] of Object.entries(orders))
    if (!r.completed)
      orders[id] = {
        ...r,
        projection: projectReceipt(r, inventory, reports[r.reportId]),
      };
  const results =
    action.type.startsWith("receipts/") && action.id
      ? Object.fromEntries(
          [...Object.entries(state.results), [action.id, error]].slice(-100),
        )
      : state.results;
  return { state: { orders, results }, posting };
}
