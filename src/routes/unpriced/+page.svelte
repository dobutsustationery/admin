<script lang="ts">
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { broadcast } from "$lib/redux-firestore";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    effectiveLedgerEntries,
    lotMatchesOrder,
    walkLedger,
    type LedgerEntry,
    type ReceiptEntry,
  } from "$lib/cost-engine";
  import { totalCumulativeValues } from "$lib/inventory-value";
  import type {
    InventoryState,
    Item,
    StockOrderCostIssue,
    StockOrderMeta,
  } from "$lib/inventory";
  import {
    mark_stock_order_row_not_received,
    reconstruct_stock_order_late_scan_receipt,
    reconstruct_stock_order_unmatched_receipt,
    selectStockOrderCostIssues,
  } from "$lib/inventory";

  type CostLedgerIssueKind = "unpriced-scan" | "missing-exchange";

  type CostLedgerIssueRow = {
    issueKind: CostLedgerIssueKind;
    issueLabel: string;
    key: string;
    jan: string;
    subtype: string;
    description: string;
    image: string;
    itemQty: number;
    shipped: number;
    lotQty: number;
    at: number;
    seq: number;
    source: string;
    unitCostJpy: number;
    unitCostEur: number;
    remainingLotQty: number;
    affectsAverage: boolean;
    currentAvgJpy: number;
    currentAvgEur: number;
    receiptCount: number;
    issueDates: number[];
    ledger: LedgerEntry[];
    ledgerIndex: number;
  };

  type CostLedgerAuditRow = {
    key: string;
    jan: string;
    subtype: string;
    description: string;
    image: string;
    kind: LedgerEntry["kind"];
    itemQty: number;
    shipped: number;
    at: number;
    seq: number;
    source: string;
    lotQty: number;
    originalQty?: number;
    reducedQty: number;
    auditComment: string;
    auditSeverity: "warning" | "danger";
    ledger: LedgerEntry[];
    ledgerIndex: number;
  };

  type StockOrderMatchIssueKind = StockOrderCostIssue["kind"];

  type StockOrderMatchIssueRow = Omit<StockOrderCostIssue, "kind"> & {
    kind: StockOrderMatchIssueKind;
    orderId: string;
    orderName: string;
    orderDate?: number;
    itemKey?: string;
    subtype: string;
    description: string;
    image: string;
    usesZeroedQuantities: boolean;
    firstScanAt?: number;
    scanAt?: number;
    source?: string;
  };

  type StockOrderMatchIssueGroup = {
    orderId: string;
    orderName: string;
    orderDate?: number;
    rows: StockOrderMatchIssueRow[];
    unmatchedRows: number;
    overmatchedRows: number;
    lateRows: number;
    differenceQty: number;
  };

  type StockOrderValueSummaryRow = {
    orderId: string;
    orderName: string;
    orderDate?: number;
    firstScanAt?: number;
    lastScanAt?: number;
    valuationAt?: number;
    valuationReason: string;
    orderValueJpy: number;
    notReceivedValueJpy: number;
    receivedOrderValueJpy: number;
    matchedOrderValueJpy: number;
    cumulativeOrderValueJpy: number;
    cumulativeInventoryValueJpy: number;
    mismatchJpy: number;
    notReceivedCount: number;
  };

  let search = "";
  let hideZeroOnHand = false;
  let onlyAffectsAverage = true;
  let showCostIssues = false;
  let showAuditAdjustments = false;
  let showStockOrderIssues: Record<string, boolean> = {};
  let copyMsg = "";
  let remediationStatus = "";
  let remediationDrafts: Record<string, { saleDate: string; note: string }> =
    {};
  let notReceivedDrafts: Record<string, { note: string }> = {};
  let pendingRemediations: Record<string, true> = {};

  const LATE_SCAN_GAP_MS = 30 * 24 * 60 * 60 * 1000;

  function isUnpricedScanReceipt(entry: LedgerEntry): entry is ReceiptEntry {
    return (
      entry.kind === "receipt" &&
      !entry.ignored &&
      entry.receivedQty !== 0 &&
      !(entry.unitCostJpy > 0) &&
      !entry.costOrderId &&
      !String(entry.source || "").startsWith("stockOrder:")
    );
  }

  function isMissingExchangeReceipt(entry: LedgerEntry): entry is ReceiptEntry {
    return (
      entry.kind === "receipt" &&
      !entry.ignored &&
      entry.unitCostJpy > 0 &&
      !(entry.unitCostEur > 0)
    );
  }

  function issueKind(entry: LedgerEntry): CostLedgerIssueKind | null {
    if (isUnpricedScanReceipt(entry)) return "unpriced-scan";
    if (isMissingExchangeReceipt(entry)) return "missing-exchange";
    return null;
  }

  function issueLabel(kind: CostLedgerIssueKind): string {
    return kind === "missing-exchange" ? "Missing exchange" : "Zero JPY scan";
  }

  function buildRows(inventory: InventoryState): CostLedgerIssueRow[] {
    const costLedger = inventory.costLedger || {};
    const idToItem = inventory.idToItem || {};
    const rows: CostLedgerIssueRow[] = [];

    for (const [key, ledger] of Object.entries(costLedger)) {
      const item = idToItem[key] as Item | undefined;
      if (!item) continue;

      const sorted = sortedLedger(effectiveLedgerEntries(ledger));
      const remainingByIndex = receiptRemainingByIndex(sorted);
      const current = walkLedger(sorted);
      const receiptCount = sorted.filter((e) => e.kind === "receipt").length;
      for (const [ledgerIndex, entry] of sorted.entries()) {
        const kind = issueKind(entry);
        if (!kind) continue;
        const receipt = entry as ReceiptEntry;
        const issueDates = sorted
          .filter((candidate) => issueKind(candidate) === kind)
          .map((candidate) => candidate.at)
          .sort((a, b) => a - b);
        rows.push({
          issueKind: kind,
          issueLabel: issueLabel(kind),
          key,
          jan: item.janCode || "",
          subtype: item.subtype || "",
          description: item.description || "",
          image: item.image || "",
          itemQty: Number(item.qty) || 0,
          shipped: Number(item.shipped) || 0,
          lotQty: entry.qty,
          at: entry.at,
          seq: entry.seq,
          source: receipt.source || "",
          unitCostJpy: receipt.unitCostJpy,
          unitCostEur: receipt.unitCostEur,
          remainingLotQty: remainingByIndex.get(ledgerIndex) || 0,
          affectsAverage: issueAffectsAverage(sorted, ledgerIndex, kind),
          currentAvgJpy: current.avgJpy,
          currentAvgEur: current.avgEur,
          receiptCount,
          issueDates,
          ledger: sorted,
          ledgerIndex,
        });
      }
    }

    return rows.sort(
      (a, b) => a.at - b.at || a.key.localeCompare(b.key) || a.seq - b.seq,
    );
  }

  function buildAuditRows(inventory: InventoryState): CostLedgerAuditRow[] {
    const costLedger = inventory.costLedger || {};
    const idToItem = inventory.idToItem || {};
    const rows: CostLedgerAuditRow[] = [];

    for (const [key, ledger] of Object.entries(costLedger)) {
      const item = idToItem[key] as Item | undefined;
      if (!item) continue;

      const sorted = sortedLedger(ledger);
      for (const [ledgerIndex, entry] of sorted.entries()) {
        const corrections =
          entry.kind === "receipt" ? entry.quantityCorrections || [] : [];
        if (!entry.auditComment && !corrections.length) continue;
        const reducedQty = corrections.reduce(
          (sum, correction) => sum + correction.reducedBy,
          0,
        );
        rows.push({
          key,
          jan: item.janCode || "",
          subtype: item.subtype || "",
          description: item.description || "",
          image: item.image || "",
          kind: entry.kind,
          itemQty: Number(item.qty) || 0,
          shipped: Number(item.shipped) || 0,
          at: entry.at,
          seq: entry.seq,
          source:
            entry.kind === "receipt"
              ? entry.costOrderId || entry.source || ""
              : "sale",
          lotQty: entry.qty,
          originalQty: entry.originalQty,
          reducedQty,
          auditComment:
            entry.auditComment ||
            `Reducer qty correction reduced this receipt by ${reducedQty} unit(s).`,
          auditSeverity:
            entry.auditSeverity || (entry.ignored ? "danger" : "warning"),
          ledger: sorted,
          ledgerIndex,
        });
      }
    }

    return rows.sort(
      (a, b) => a.at - b.at || a.key.localeCompare(b.key) || a.seq - b.seq,
    );
  }

  function buildStockOrderMatchIssueRows(
    inventory: InventoryState,
  ): StockOrderMatchIssueRow[] {
    const rows: StockOrderMatchIssueRow[] = [];
    const idToItem = inventory.idToItem || {};
    const costLedger = inventory.costLedger || {};
    for (const [orderId, meta] of Object.entries(
      inventory.stockOrderRegistry || {},
    )) {
      for (const issue of selectStockOrderCostIssues(inventory, orderId)) {
        const hit = issue.itemKey
          ? ([issue.itemKey, idToItem[issue.itemKey]] as const)
          : Object.entries(idToItem)
              .filter(([, item]) => item.janCode === issue.jan)
              .sort(([a], [b]) => a.localeCompare(b))[0];
        const [itemKey, item] = hit || [];
        rows.push({
          ...issue,
          orderId,
          orderName: meta.name || meta.supplier || "",
          orderDate: meta.receivedAt,
          itemKey,
          subtype: item?.subtype || "",
          description: item?.description || "",
          image: item?.image || "",
          usesZeroedQuantities: meta.usesZeroedQuantities === true,
          firstScanAt: itemKey
            ? firstScanAtForLedger(costLedger[itemKey])
            : undefined,
          scanAt: issue.scanAt,
          source: issue.source,
        });
      }
    }
    return rows.sort(
      (a, b) =>
        a.orderId.localeCompare(b.orderId) ||
        a.jan.localeCompare(b.jan) ||
        a.kind.localeCompare(b.kind),
    );
  }

  function orderCostRowsValue(meta: StockOrderMeta): number {
    const costRowsValue = (meta.costRows || []).reduce((sum, row) => {
      const qty = Number(row.qty);
      const unitCostJpy = Number(row.unitCostJpy);
      return sum + (qty > 0 && unitCostJpy > 0 ? qty * unitCostJpy : 0);
    }, 0);
    return costRowsValue || meta.valueOfGoodsJpy || meta.valueOfOrderJpy || 0;
  }

  function orderNotReceivedValue(meta: StockOrderMeta): number {
    return (meta.notReceivedRows || []).reduce((sum, row) => {
      const qty = Number(row.qty);
      const unitCostJpy = Number(row.unitCostJpy);
      return sum + (qty > 0 && unitCostJpy > 0 ? qty * unitCostJpy : 0);
    }, 0);
  }

  type OrderScanReceipt = {
    itemKey: string;
    at: number;
    qty: number;
    unitCostJpy: number;
    source?: string;
  };

  function monthEndMs(ms: number): number {
    const date = new Date(ms);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
  }

  function orderScanReceipts(
    orderId: string,
    inventory: InventoryState,
  ): OrderScanReceipt[] {
    const scans: OrderScanReceipt[] = [];
    for (const [itemKey, ledger] of Object.entries(
      inventory.costLedger || {},
    )) {
      for (const entry of effectiveLedgerEntries(ledger)) {
        if (
          entry.kind !== "receipt" ||
          entry.ignored ||
          !lotMatchesOrder(entry, orderId) ||
          String(entry.source || "").startsWith("stockOrder:") ||
          !Number.isFinite(entry.at) ||
          entry.at <= 0
        ) {
          continue;
        }
        scans.push({
          itemKey,
          at: entry.at,
          qty: Number(entry.qty) || 0,
          unitCostJpy: Number(entry.unitCostJpy) || 0,
          source: entry.source,
        });
      }
    }
    return scans.sort(
      (a, b) => a.at - b.at || a.itemKey.localeCompare(b.itemKey),
    );
  }

  function scanWindowForOrder(orderId: string, inventory: InventoryState) {
    const scans = orderScanReceipts(orderId, inventory);
    const firstScanAt = scans[0]?.at;
    const lastScanAt = scans.at(-1)?.at;
    const hasLargeGap =
      firstScanAt != null &&
      lastScanAt != null &&
      lastScanAt - firstScanAt > LATE_SCAN_GAP_MS;
    const valuationAt =
      hasLargeGap && firstScanAt != null ? monthEndMs(firstScanAt) : lastScanAt;
    const lateScans =
      valuationAt != null && hasLargeGap
        ? scans.filter((scan) => scan.at > valuationAt)
        : [];
    return {
      scans,
      firstScanAt,
      lastScanAt,
      valuationAt,
      hasLargeGap,
      lateScans,
    };
  }

  function cumulativeInventoryValueJpyAsOf(
    inventory: InventoryState,
    asOf: number,
  ) {
    return totalCumulativeValues(
      Object.values(inventory.costLedger || {}),
      asOf,
    ).inventoryJpy;
  }

  function matchedOrderReceiptValueJpy(
    orderId: string,
    inventory: InventoryState,
  ): number {
    let total = 0;
    for (const ledger of Object.values(inventory.costLedger || {})) {
      for (const entry of effectiveLedgerEntries(ledger)) {
        if (
          entry.kind !== "receipt" ||
          entry.ignored ||
          !lotMatchesOrder(entry, orderId)
        ) {
          continue;
        }
        total += (Number(entry.qty) || 0) * (Number(entry.unitCostJpy) || 0);
      }
    }
    return total;
  }

  function buildStockOrderValueSummaryRows(
    inventory: InventoryState,
  ): StockOrderValueSummaryRow[] {
    const rows = Object.entries(inventory.stockOrderRegistry || {})
      .map(([orderId, meta]) => {
        const orderValueJpy = orderCostRowsValue(meta);
        const notReceivedValueJpy = orderNotReceivedValue(meta);
        const receivedOrderValueJpy = Math.max(
          0,
          orderValueJpy - notReceivedValueJpy,
        );
        const scanWindow = scanWindowForOrder(orderId, inventory);
        const valuationAt = scanWindow.valuationAt || meta.receivedAt;
        const valuationReason = scanWindow.hasLargeGap
          ? "month end after first scan"
          : scanWindow.lastScanAt
            ? "last scan"
            : "order date";
        return {
          orderId,
          orderName: meta.name || meta.supplier || "",
          orderDate: meta.receivedAt,
          firstScanAt: scanWindow.firstScanAt,
          lastScanAt: scanWindow.lastScanAt,
          valuationAt,
          valuationReason,
          orderValueJpy,
          notReceivedValueJpy,
          receivedOrderValueJpy,
          cumulativeOrderValueJpy: 0,
          cumulativeInventoryValueJpy: 0,
          mismatchJpy: 0,
          matchedOrderValueJpy: matchedOrderReceiptValueJpy(orderId, inventory),
          notReceivedCount: meta.notReceivedRows?.length || 0,
        };
      })
      .sort((a, b) => {
        const aDate = a.orderDate || Number.MAX_SAFE_INTEGER;
        const bDate = b.orderDate || Number.MAX_SAFE_INTEGER;
        return aDate - bDate || a.orderId.localeCompare(b.orderId);
      });

    let cumulativeOrderValueJpy = 0;
    for (const row of rows) {
      const asOf = row.valuationAt || 0;
      cumulativeOrderValueJpy += row.receivedOrderValueJpy;
      row.cumulativeOrderValueJpy = Math.round(cumulativeOrderValueJpy);
      row.cumulativeInventoryValueJpy =
        asOf > 0
          ? Math.round(cumulativeInventoryValueJpyAsOf(inventory, asOf))
          : 0;
      row.mismatchJpy =
        row.cumulativeInventoryValueJpy - row.cumulativeOrderValueJpy;
    }

    return rows;
  }

  function groupStockOrderMatchIssueRows(
    rows: StockOrderMatchIssueRow[],
  ): StockOrderMatchIssueGroup[] {
    const groups = new Map<string, StockOrderMatchIssueGroup>();
    for (const row of rows) {
      const group = groups.get(row.orderId) || {
        orderId: row.orderId,
        orderName: row.orderName,
        orderDate: row.orderDate,
        rows: [],
        unmatchedRows: 0,
        overmatchedRows: 0,
        lateRows: 0,
        differenceQty: 0,
      };
      group.rows.push(row);
      group.differenceQty += Number(row.qty) || 0;
      if (row.kind === "unmatched-row") group.unmatchedRows++;
      if (row.kind === "overmatched-row") group.overmatchedRows++;
      if (row.kind === "late-scan") group.lateRows++;
      groups.set(row.orderId, group);
    }
    return [...groups.values()].sort((a, b) => {
      const aDate = validSortDate(a.orderDate);
      const bDate = validSortDate(b.orderDate);
      return (
        aDate - bDate ||
        a.orderName.localeCompare(b.orderName) ||
        a.orderId.localeCompare(b.orderId)
      );
    });
  }

  $: rows = buildRows($store.inventory);
  $: auditRows = buildAuditRows($store.inventory);
  $: stockOrderMatchIssueRows = buildStockOrderMatchIssueRows($store.inventory);
  $: stockOrderValueSummaryRows = buildStockOrderValueSummaryRows(
    $store.inventory,
  );
  $: query = search.trim().toLowerCase();
  $: filteredRows = rows.filter((row) => {
    if (hideZeroOnHand && row.itemQty - row.shipped <= 0) return false;
    if (onlyAffectsAverage && !row.affectsAverage) return false;
    if (!query) return true;
    return (
      row.key.toLowerCase().includes(query) ||
      row.jan.includes(query) ||
      row.description.toLowerCase().includes(query) ||
      row.subtype.toLowerCase().includes(query)
    );
  });
  $: filteredAuditRows = auditRows.filter((row) => {
    if (hideZeroOnHand && row.itemQty - row.shipped <= 0) return false;
    if (!query) return true;
    return (
      row.key.toLowerCase().includes(query) ||
      row.jan.includes(query) ||
      row.description.toLowerCase().includes(query) ||
      row.subtype.toLowerCase().includes(query)
    );
  });
  $: filteredStockOrderMatchIssueRows = stockOrderMatchIssueRows.filter(
    (row) => {
      if (!query) return true;
      return (
        row.orderId.toLowerCase().includes(query) ||
        row.orderName.toLowerCase().includes(query) ||
        row.jan.includes(query) ||
        (row.itemKey || "").toLowerCase().includes(query) ||
        row.description.toLowerCase().includes(query) ||
        row.subtype.toLowerCase().includes(query)
      );
    },
  );
  $: stockOrderMatchIssueGroups = groupStockOrderMatchIssueRows(
    filteredStockOrderMatchIssueRows,
  );
  $: totalLotQty = rows.reduce((sum, row) => sum + row.lotQty, 0);
  $: filteredLotQty = filteredRows.reduce((sum, row) => sum + row.lotQty, 0);
  $: filteredAffectingRows = filteredRows.filter(
    (row) => row.affectsAverage,
  ).length;
  $: itemCount = new Set(rows.map((row) => row.key)).size;
  $: affectingRows = rows.filter((row) => row.affectsAverage).length;
  $: zeroJpyRows = rows.filter(
    (row) => row.issueKind === "unpriced-scan",
  ).length;
  $: missingExchangeRows = rows.filter(
    (row) => row.issueKind === "missing-exchange",
  ).length;
  $: unmatchedOrderRows = stockOrderMatchIssueRows.filter(
    (row) => row.kind === "unmatched-row",
  ).length;
  $: overmatchedOrderRows = stockOrderMatchIssueRows.filter(
    (row) => row.kind === "overmatched-row",
  ).length;

  function fmtDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    return new Date(ms).toISOString().slice(0, 10);
  }

  function dateInputValue(ms: number | undefined): string {
    return ms && Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString().slice(0, 10)
      : "";
  }

  function firstScanAtForLedger(
    ledger: readonly LedgerEntry[] | undefined,
  ): number | undefined {
    const sorted = sortedLedger(ledger || []);
    const scan = sorted.find(
      (entry) =>
        entry.kind === "receipt" &&
        entry.source === "update_item" &&
        Number.isFinite(entry.at) &&
        entry.at > 0,
    );
    if (scan) return scan.at;

    const nonOrderReceipt = sorted.find(
      (entry) =>
        entry.kind === "receipt" &&
        !String(entry.source || "").startsWith("stockOrder:") &&
        Number.isFinite(entry.at) &&
        entry.at > 0,
    );
    if (nonOrderReceipt) return nonOrderReceipt.at;

    return sorted.find(
      (entry) =>
        entry.kind === "receipt" && Number.isFinite(entry.at) && entry.at > 0,
    )?.at;
  }

  function uniqueDateLabels(values: number[]): string {
    return Array.from(new Set(values.map(fmtDate))).join(", ");
  }

  function fmtYen(n: number): string {
    return Number.isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "-";
  }

  function fmtEur(n: number): string {
    return Number.isFinite(n) && n > 0 ? `€${n.toFixed(2)}` : "-";
  }

  function stockOrderMatchIssueLabel(kind: StockOrderMatchIssueKind): string {
    if (kind === "late-scan") return "Late scan";
    return kind === "overmatched-row" ? "Overmatched row" : "Unmatched row";
  }

  function fmtQty(n: number | undefined): string {
    if (!Number.isFinite(n)) return "-";
    return Number.isInteger(n as number) ? String(n) : (n as number).toFixed(2);
  }

  function validSortDate(ms: number | undefined): number {
    return Number.isFinite(ms) && (ms as number) > 0
      ? (ms as number)
      : Number.MAX_SAFE_INTEGER;
  }

  function toggleCostIssues() {
    const nextOpen = !showCostIssues;
    console.log("[CostIssues] twisty handler fired", {
      key: "cost-issues",
      wasOpen: showCostIssues,
      nextOpen,
      at: new Date().toISOString(),
    });
    showCostIssues = nextOpen;
  }

  function toggleStockOrderIssues(orderId: string) {
    const nextOpen = !showStockOrderIssues[orderId];
    console.log("[CostIssues] twisty handler fired", {
      key: `stock-order:${orderId}`,
      wasOpen: !!showStockOrderIssues[orderId],
      nextOpen,
      at: new Date().toISOString(),
    });
    showStockOrderIssues = { ...showStockOrderIssues, [orderId]: nextOpen };
  }

  function toggleAuditAdjustments() {
    const nextOpen = !showAuditAdjustments;
    console.log("[CostIssues] twisty handler fired", {
      key: "audit-adjustments",
      wasOpen: showAuditAdjustments,
      nextOpen,
      at: new Date().toISOString(),
    });
    showAuditAdjustments = nextOpen;
  }

  function tsvCell(value: unknown): string {
    return String(value ?? "")
      .replace(/\t/g, " ")
      .replace(/\r?\n/g, " ")
      .trim();
  }

  function toTsv(headers: string[], rows: unknown[][]): string {
    return [
      headers.map(tsvCell).join("\t"),
      ...rows.map((row) => row.map(tsvCell).join("\t")),
    ].join("\n");
  }

  async function copyTsv(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copyMsg = `Copied ${label}.`;
    } catch {
      copyMsg = "Clipboard blocked.";
    }
  }

  function remediationKey(row: StockOrderMatchIssueRow): string {
    return `${row.orderId}:${row.kind}:${row.jan}:${row.itemKey || ""}`;
  }

  function stockOrderIssueRowKey(row: StockOrderMatchIssueRow): string {
    return [
      "order-match",
      row.orderId,
      row.kind,
      row.jan,
      row.itemKey || "",
      row.scanAt || "",
      row.qty,
      row.unitCostJpy || "",
    ].join(":");
  }

  function canReconstruct(row: StockOrderMatchIssueRow): boolean {
    return (
      row.kind === "unmatched-row" &&
      row.usesZeroedQuantities &&
      Boolean(row.itemKey)
    );
  }

  function canReconstructLateScan(row: StockOrderMatchIssueRow): boolean {
    return row.kind === "late-scan" && Boolean(row.itemKey);
  }

  function canMarkNotReceived(row: StockOrderMatchIssueRow): boolean {
    return row.kind === "unmatched-row" && row.qty > 0;
  }

  function canOpenCostLedger(row: StockOrderMatchIssueRow): boolean {
    return row.kind === "overmatched-row" && Boolean(row.jan);
  }

  function costLedgerSearchUrl(row: StockOrderMatchIssueRow): string {
    return `/cost-ledger-editor?search=${encodeURIComponent(row.jan)}`;
  }

  function subtypeReplacementUrl(jan: string, itemKey?: string): string {
    const params = new URLSearchParams({ jan });
    if (itemKey) params.set("itemKey", itemKey);
    return `/subtype-exceptions?${params.toString()}`;
  }

  function hasSubtypeReplacementOption(jan: string, itemKey?: string): boolean {
    if (!jan || !itemKey) return false;
    const subtypeRows = Object.entries($store.inventory.idToItem || {}).filter(
      ([key, item]: [string, any]) =>
        key !== jan &&
        (item.janCode || "").trim() === jan.trim() &&
        (item.subtype || "").trim(),
    );
    return subtypeRows.length >= 2;
  }

  function remediationDraft(row: StockOrderMatchIssueRow) {
    const key = remediationKey(row);
    const stored = remediationDrafts[key];
    if (stored) return stored;
    return {
      saleDate: dateInputValue(row.firstScanAt),
      note: "",
    };
  }

  function notReceivedDraft(row: StockOrderMatchIssueRow) {
    return notReceivedDrafts[remediationKey(row)] || { note: "" };
  }

  function setRemediationDraft(
    row: StockOrderMatchIssueRow,
    field: "saleDate" | "note",
    value: string,
  ) {
    const key = remediationKey(row);
    remediationDrafts = {
      ...remediationDrafts,
      [key]: {
        ...remediationDraft(row),
        [field]: value,
      },
    };
  }

  function setNotReceivedDraft(row: StockOrderMatchIssueRow, note: string) {
    notReceivedDrafts = {
      ...notReceivedDrafts,
      [remediationKey(row)]: { note },
    };
  }

  async function reconstructMissingReceipt(row: StockOrderMatchIssueRow) {
    const key = remediationKey(row);
    const draft = remediationDraft(row);
    const note = draft.note.trim();
    const saleAt = draft.saleDate
      ? Date.parse(`${draft.saleDate}T00:00:00Z`)
      : NaN;
    if (!$user.uid) {
      remediationStatus = "Sign in before applying a remediation.";
      return;
    }
    if (!canReconstruct(row) || !row.itemKey) {
      remediationStatus = "This row cannot be reconstructed from here.";
      return;
    }
    if (!Number.isFinite(saleAt)) {
      remediationStatus = "Enter the historical sale/consumption date.";
      return;
    }
    if (!note) {
      remediationStatus = "Enter an audit note for the reconstruction.";
      return;
    }

    pendingRemediations = { ...pendingRemediations, [key]: true };
    remediationStatus = "";
    try {
      await broadcast(
        firestore,
        $user.uid,
        reconstruct_stock_order_unmatched_receipt({
          orderId: row.orderId,
          itemKey: row.itemKey,
          qty: row.qty,
          note,
          saleAt,
          saleNote: note,
        }),
      );
      remediationStatus = `Reconstructed ${fmtQty(row.qty)} unit(s) for ${row.jan}.`;
      const nextDrafts = { ...remediationDrafts };
      delete nextDrafts[key];
      remediationDrafts = nextDrafts;
    } catch (error) {
      remediationStatus =
        error instanceof Error ? error.message : "Failed to save remediation.";
    } finally {
      const nextPending = { ...pendingRemediations };
      delete nextPending[key];
      pendingRemediations = nextPending;
    }
  }

  async function markNotReceived(row: StockOrderMatchIssueRow) {
    const key = remediationKey(row);
    const note = notReceivedDraft(row).note.trim();
    if (!$user.uid) {
      remediationStatus = "Sign in before applying a remediation.";
      return;
    }
    if (!canMarkNotReceived(row)) {
      remediationStatus = "This row cannot be marked not received.";
      return;
    }
    if (!note) {
      remediationStatus = "Enter an audit note for the not received row.";
      return;
    }

    pendingRemediations = { ...pendingRemediations, [key]: true };
    remediationStatus = "";
    try {
      await broadcast(
        firestore,
        $user.uid,
        mark_stock_order_row_not_received({
          orderId: row.orderId,
          jan: row.jan,
          qty: row.qty,
          note,
        }),
      );
      remediationStatus = `Marked ${fmtQty(row.qty)} unit(s) of ${row.jan} not accepted/received.`;
      const nextDrafts = { ...notReceivedDrafts };
      delete nextDrafts[key];
      notReceivedDrafts = nextDrafts;
    } catch (error) {
      remediationStatus =
        error instanceof Error ? error.message : "Failed to save remediation.";
    } finally {
      const nextPending = { ...pendingRemediations };
      delete nextPending[key];
      pendingRemediations = nextPending;
    }
  }

  async function reconstructLateScanReceipt(row: StockOrderMatchIssueRow) {
    const key = remediationKey(row);
    const note = remediationDraft(row).note.trim();
    if (!$user.uid) {
      remediationStatus = "Sign in before applying a remediation.";
      return;
    }
    if (!canReconstructLateScan(row) || !row.itemKey) {
      remediationStatus = "This late scan row cannot be reconstructed.";
      return;
    }
    if (!note) {
      remediationStatus = "Enter an audit note for the late scan correction.";
      return;
    }

    pendingRemediations = { ...pendingRemediations, [key]: true };
    remediationStatus = "";
    try {
      await broadcast(
        firestore,
        $user.uid,
        reconstruct_stock_order_late_scan_receipt({
          orderId: row.orderId,
          itemKey: row.itemKey,
          note,
        }),
      );
      remediationStatus = `Reconstructed order-date receipt for ${row.itemKey}.`;
      const nextDrafts = { ...remediationDrafts };
      delete nextDrafts[key];
      remediationDrafts = nextDrafts;
    } catch (error) {
      remediationStatus =
        error instanceof Error ? error.message : "Failed to save remediation.";
    } finally {
      const nextPending = { ...pendingRemediations };
      delete nextPending[key];
      pendingRemediations = nextPending;
    }
  }

  function costIssuesTsv(rows: CostLedgerIssueRow[]): string {
    return toTsv(
      [
        "Key",
        "JAN",
        "Subtype",
        "Description",
        "Issue dates",
        "Lot date",
        "Issue",
        "Lot qty",
        "Remaining lot qty",
        "On hand",
        "Item qty",
        "Current avg JPY",
        "Current avg EUR",
        "Raw JPY",
        "Raw EUR",
        "Source",
      ],
      rows.map((row) => [
        row.key,
        row.jan,
        row.subtype,
        row.description,
        uniqueDateLabels(row.issueDates),
        fmtDate(row.at),
        row.issueLabel,
        row.lotQty,
        row.remainingLotQty,
        Math.max(0, row.itemQty - row.shipped),
        row.itemQty,
        Math.round(row.currentAvgJpy),
        row.currentAvgEur,
        row.unitCostJpy,
        row.unitCostEur,
        row.source,
      ]),
    );
  }

  function stockOrderGroupTsv(group: StockOrderMatchIssueGroup): string {
    return toTsv(
      [
        "Order ID",
        "Order name",
        "Order date",
        "Item key",
        "JAN",
        "Subtype",
        "Description",
        "Issue",
        "Scan date",
        "Expected qty",
        "Matched qty",
        "Difference",
        "Unit cost JPY",
        "Line cost JPY",
      ],
      group.rows.map((row) => [
        row.orderId,
        row.orderName,
        fmtDate(row.orderDate || 0),
        row.itemKey || "",
        row.jan,
        row.subtype,
        row.description,
        stockOrderMatchIssueLabel(row.kind),
        fmtDate(row.scanAt || 0),
        fmtQty(row.expectedQty),
        fmtQty(row.matchedQty),
        fmtQty(row.qty),
        row.unitCostJpy || 0,
        row.lineCostJpy || 0,
      ]),
    );
  }

  function auditAdjustmentsTsv(rows: CostLedgerAuditRow[]): string {
    return toTsv(
      [
        "Key",
        "JAN",
        "Subtype",
        "Description",
        "Date",
        "Kind",
        "Current lot qty",
        "Original qty",
        "Reduced by",
        "Source",
        "Severity",
        "Audit comment",
      ],
      rows.map((row) => [
        row.key,
        row.jan,
        row.subtype,
        row.description,
        fmtDate(row.at),
        row.kind,
        fmtQty(row.lotQty),
        fmtQty(row.originalQty),
        fmtQty(row.reducedQty),
        row.source,
        row.auditSeverity,
        row.auditComment,
      ]),
    );
  }

  function sortedLedger(ledger: readonly LedgerEntry[]): LedgerEntry[] {
    return [...ledger].sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function receiptRemainingByIndex(
    ledger: readonly LedgerEntry[],
  ): Map<number, number> {
    const remaining = new Map<number, number>();
    const openLots: { index: number; remaining: number }[] = [];

    for (const [index, entry] of ledger.entries()) {
      if (entry.ignored) continue;
      if (entry.kind === "receipt") {
        const qty = Math.max(0, Number(entry.qty) || 0);
        remaining.set(index, qty);
        openLots.push({ index, remaining: qty });
        continue;
      }

      let saleQty = Math.max(0, Number(entry.qty) || 0);
      for (const lot of openLots) {
        if (saleQty <= 0) break;
        const consumed = Math.min(lot.remaining, saleQty);
        lot.remaining -= consumed;
        saleQty -= consumed;
        remaining.set(lot.index, lot.remaining);
      }
    }

    return remaining;
  }

  function issueAffectsAverage(
    ledger: readonly LedgerEntry[],
    ledgerIndex: number,
    kind: CostLedgerIssueKind,
  ): boolean {
    const entry = ledger[ledgerIndex];
    if (!entry || entry.kind !== "receipt" || entry.ignored || entry.qty <= 0) {
      return false;
    }

    const baseline = walkLedger(ledger);
    if (baseline.onHand <= 0) return false;

    const adjusted = ledger.map((candidate, index) =>
      index === ledgerIndex ? { ...candidate } : candidate,
    );
    const adjustedEntry = adjusted[ledgerIndex];
    if (!adjustedEntry || adjustedEntry.kind !== "receipt") return false;

    if (kind === "missing-exchange") {
      adjustedEntry.unitCostEur += 1;
    } else {
      adjustedEntry.unitCostJpy += 1;
    }

    const next = walkLedger(adjusted);
    const epsilon = 0.000001;
    if (kind === "missing-exchange") {
      return Math.abs(next.avgEur - baseline.avgEur) > epsilon;
    }
    return Math.abs(next.avgJpy - baseline.avgJpy) > epsilon;
  }

  function ledgerEntryLabel(entry: LedgerEntry): string {
    const base = `${fmtDate(entry.at)} ${entry.kind} ${entry.qty}`;
    if (entry.kind !== "receipt") {
      return entry.isArchive ? `${base} archive` : base;
    }
    const source = entry.costOrderId || entry.source || "";
    return `${base} @ ${fmtYen(entry.unitCostJpy)} / ${fmtEur(entry.unitCostEur)}${source ? ` ${source}` : ""}`;
  }
</script>

<svelte:head><title>Cost Ledger Issues</title></svelte:head>

<main>
  <h1>Cost Ledger Issues</h1>

  <div class="summary">
    <div>
      <strong>{rows.length}</strong>
      <span>lot(s)</span>
    </div>
    <div>
      <strong>{itemCount}</strong>
      <span>item(s)</span>
    </div>
    <div>
      <strong>{totalLotQty}</strong>
      <span>unit(s)</span>
    </div>
    <div>
      <strong>{zeroJpyRows}</strong>
      <span>zero JPY</span>
    </div>
    <div>
      <strong>{missingExchangeRows}</strong>
      <span>missing exchange</span>
    </div>
    <div>
      <strong>{unmatchedOrderRows}</strong>
      <span>unmatched order row(s)</span>
    </div>
    <div>
      <strong>{overmatchedOrderRows}</strong>
      <span>overmatched order row(s)</span>
    </div>
    <div>
      <strong>{auditRows.length}</strong>
      <span>audit adjustment(s)</span>
    </div>
  </div>

  {#if copyMsg}
    <p class="copy-status">{copyMsg}</p>
  {/if}

  <h2>Order Value Summary</h2>
  {#if stockOrderValueSummaryRows.length > 0}
    <div class="table-section">
      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Order date</th>
            <th>Valuation date</th>
            <th>Order value</th>
            <th>Order value received</th>
            <th>Cumulative order value</th>
            <th>Cumulative inventory value</th>
            <th>Difference</th>
          </tr>
        </thead>
        <tbody>
          {#each stockOrderValueSummaryRows as row (row.orderId)}
            <tr class:order-value-mismatch={Math.abs(row.mismatchJpy) > 1}>
              <td>
                <strong>{row.orderId}</strong>
                {#if row.orderName}
                  <div>{row.orderName}</div>
                {/if}
                {#if row.notReceivedCount > 0}
                  <span class="hint">
                    {row.notReceivedCount} not accepted/received adjustment(s)
                  </span>
                {/if}
              </td>
              <td>{fmtDate(row.orderDate || 0)}</td>
              <td>
                <div>{fmtDate(row.valuationAt || 0)}</div>
                <span class="hint">{row.valuationReason}</span>
                {#if row.firstScanAt || row.lastScanAt}
                  <div class="hint">
                    scans {fmtDate(row.firstScanAt || 0)} - {fmtDate(
                      row.lastScanAt || 0,
                    )}
                  </div>
                {/if}
              </td>
              <td>
                <div>{fmtYen(row.orderValueJpy)}</div>
                {#if row.notReceivedValueJpy > 0}
                  <span class="hint">
                    {fmtYen(row.notReceivedValueJpy)} not accepted
                  </span>
                {/if}
              </td>
              <td>
                <div>{fmtYen(row.receivedOrderValueJpy)}</div>
                {#if Math.abs(row.receivedOrderValueJpy - row.matchedOrderValueJpy) > 1}
                  <span class="hint">
                    {fmtYen(row.matchedOrderValueJpy)} matched
                  </span>
                {/if}
              </td>
              <td>
                {row.valuationAt ? fmtYen(row.cumulativeOrderValueJpy) : "-"}
              </td>
              <td>
                {row.valuationAt
                  ? fmtYen(row.cumulativeInventoryValueJpy)
                  : "-"}
              </td>
              <td>{row.valuationAt ? fmtYen(row.mismatchJpy) : "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="hint">No stock order values have been registered.</p>
  {/if}

  <h2>Cost Issues</h2>

  <div class="controls cost-issue-controls">
    <label>
      Search
      <input bind:value={search} placeholder="JAN, key, or description" />
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={hideZeroOnHand} />
      Hide zero on-hand items
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={onlyAffectsAverage} />
      Only lots still affecting avg
    </label>
  </div>

  <p class="hint">
    Showing {filteredRows.length} lot(s), {filteredLotQty} unit(s). These are receipt
    lots with zero JPY scan cost or JPY cost without EUR/exchange.
    {affectingRows} still affect the moving average.
  </p>

  <div class="table-section">
    <div class="table-summary">
      <div>
        <strong>Cost Issues</strong>
        <span>
          {filteredRows.length} row(s), {filteredLotQty} unit(s), {filteredAffectingRows}
          affecting average.
        </span>
      </div>
      <button
        type="button"
        class="copy-button twisty-button"
        on:click={toggleCostIssues}
      >
        {showCostIssues ? "v Hide" : "> Show"}
      </button>
      <button
        type="button"
        class="copy-button"
        on:click={() => copyTsv("Cost Issues TSV", costIssuesTsv(filteredRows))}
      >
        Copy TSV
      </button>
    </div>

    <div class:hidden={!showCostIssues}>
      <table>
        <thead>
          <tr>
            <th>Image</th>
            <th>Item</th>
            <th>Issue dates</th>
            <th>Current lot</th>
            <th>Issue</th>
            <th>Qty</th>
            <th>On hand</th>
            <th>Current avg</th>
            <th>Cost ledger</th>
            <th>Raw cost</th>
          </tr>
        </thead>
        <tbody>
          {#each filteredRows as row (`${row.issueKind}:${row.key}:${row.at}:${row.seq}:${row.lotQty}`)}
            <tr class:missingExchange={row.issueKind === "missing-exchange"}>
              <td class="thumb-cell">
                {#if row.image}
                  <ImageThumbnail
                    src={row.image}
                    alt={row.description}
                    width="56px"
                    height="56px"
                  />
                {:else}
                  <span class="no-thumb">-</span>
                {/if}
              </td>
              <td>
                <a href={`/itemhistory?itemKey=${encodeURIComponent(row.key)}`}>
                  <strong>{row.key}</strong>
                </a>
                <div>{row.description}</div>
                {#if row.subtype}
                  <span class="hint">{row.subtype}</span>
                {/if}
                {#if hasSubtypeReplacementOption(row.jan, row.key)}
                  <div>
                    <a
                      class="remediation-link"
                      href={subtypeReplacementUrl(row.jan, row.key)}
                    >
                      Resolve subtype replacement
                    </a>
                  </div>
                {/if}
              </td>
              <td>
                <div>{uniqueDateLabels(row.issueDates)}</div>
                <span class="hint"
                  >{row.issueDates.length} matching issue lot(s)</span
                >
              </td>
              <td>
                <div>{fmtDate(row.at)}</div>
                <span class="hint">seq {row.seq} · {row.source || "-"}</span>
                <div class="hint">
                  remaining from lot: {row.remainingLotQty} / {row.lotQty}
                </div>
                <div class="hint">
                  avg impact: {row.affectsAverage ? "yes" : "no"}
                </div>
              </td>
              <td>
                <span class={`issue ${row.issueKind}`}>{row.issueLabel}</span>
              </td>
              <td>{row.lotQty}</td>
              <td>{Math.max(0, row.itemQty - row.shipped)} / {row.itemQty}</td>
              <td>
                <div>{fmtYen(row.currentAvgJpy)}</div>
                <span class="hint">{fmtEur(row.currentAvgEur)}</span>
              </td>
              <td class="ledger-cell">
                {#each row.ledger as entry, index}
                  <div class:target-entry={index === row.ledgerIndex}>
                    {ledgerEntryLabel(entry)}
                  </div>
                {/each}
              </td>
              <td>
                <div>{fmtYen(row.unitCostJpy)}</div>
                <span class="hint">{fmtEur(row.unitCostEur)}</span>
                <div class="hint">{row.receiptCount} receipt lot(s)</div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>

  <h2>Stock Order Match Issues</h2>
  {#if remediationStatus}
    <p class="copy-status">{remediationStatus}</p>
  {/if}
  {#if stockOrderMatchIssueGroups.length > 0}
    {#each stockOrderMatchIssueGroups as group (group.orderId)}
      <section class="order-issue-section">
        <h3>
          <span>{group.orderId}</span>
          {#if group.orderName}
            <span class="hint">{group.orderName}</span>
          {/if}
        </h3>
        <p class="hint">
          {group.rows.length} issue row(s), {fmtQty(group.differenceQty)} unit(s)
          different.
          {group.unmatchedRows} unmatched, {group.overmatchedRows} overmatched,
          {group.lateRows} late scan.
        </p>
        <div class="table-section">
          <div class="table-summary">
            <div>
              <strong>{fmtDate(group.orderDate || 0)}</strong>
              <span>
                {group.rows.length} row(s), {fmtQty(group.differenceQty)} unit(s)
                different.
                {#if group.lateRows > 0}
                  {group.lateRows} late scan row(s).
                {/if}
              </span>
            </div>
            <button
              type="button"
              class="copy-button twisty-button"
              on:click={() => toggleStockOrderIssues(group.orderId)}
            >
              {showStockOrderIssues[group.orderId] ? "v Hide" : "> Show"}
            </button>
            <button
              type="button"
              class="copy-button"
              on:click={() =>
                copyTsv(`${group.orderId} TSV`, stockOrderGroupTsv(group))}
            >
              Copy TSV
            </button>
          </div>
          <div class:hidden={!showStockOrderIssues[group.orderId]}>
            <table>
              <thead>
                <tr>
                  <th>Image</th>
                  <th>Item</th>
                  <th>Issue</th>
                  <th>Expected qty</th>
                  <th>Matched qty</th>
                  <th>Difference</th>
                  <th>Row cost</th>
                  <th>Remediation</th>
                </tr>
              </thead>
              <tbody>
                {#each group.rows as row (stockOrderIssueRowKey(row))}
                  <tr
                    class:stock-order-unmatched={row.kind === "unmatched-row"}
                    class:stock-order-overmatched={row.kind ===
                      "overmatched-row"}
                    class:stock-order-late={row.kind === "late-scan"}
                  >
                    <td class="thumb-cell">
                      {#if row.image}
                        <ImageThumbnail
                          src={row.image}
                          alt={row.description}
                          width="56px"
                          height="56px"
                        />
                      {:else}
                        <span class="no-thumb">-</span>
                      {/if}
                    </td>
                    <td>
                      {#if row.itemKey}
                        <a
                          href={`/itemhistory?itemKey=${encodeURIComponent(row.itemKey)}`}
                        >
                          <strong>{row.itemKey}</strong>
                        </a>
                      {:else}
                        <strong>{row.jan}</strong>
                      {/if}
                      {#if row.description}
                        <div>{row.description}</div>
                      {/if}
                      {#if row.subtype}
                        <span class="hint">{row.subtype}</span>
                      {/if}
                    </td>
                    <td>
                      <span class={`issue ${row.kind}`}>
                        {stockOrderMatchIssueLabel(row.kind)}
                      </span>
                      {#if row.scanAt}
                        <div class="hint">
                          scanned {fmtDate(row.scanAt)}{row.source
                            ? ` · ${row.source}`
                            : ""}
                        </div>
                      {/if}
                    </td>
                    <td>{fmtQty(row.expectedQty)}</td>
                    <td>{fmtQty(row.matchedQty)}</td>
                    <td>{fmtQty(row.qty)}</td>
                    <td>
                      <div>{fmtYen(row.unitCostJpy || 0)} / unit</div>
                      <span class="hint">
                        {fmtYen(row.lineCostJpy || 0)} difference
                      </span>
                    </td>
                    <td>
                      {#if canReconstruct(row) || canReconstructLateScan(row) || canMarkNotReceived(row) || canOpenCostLedger(row) || hasSubtypeReplacementOption(row.jan, row.itemKey)}
                        <div class="remediation-form">
                          {#if hasSubtypeReplacementOption(row.jan, row.itemKey)}
                            <a
                              class="copy-button remediation-link"
                              href={subtypeReplacementUrl(row.jan, row.itemKey)}
                            >
                              Resolve subtype replacement
                            </a>
                          {/if}
                          {#if canOpenCostLedger(row)}
                            <a
                              class="copy-button remediation-link"
                              href={costLedgerSearchUrl(row)}
                            >
                              Open cost ledger
                            </a>
                          {/if}
                          {#if canReconstruct(row)}
                            <label>
                              Sale date
                              <input
                                type="date"
                                value={remediationDraft(row).saleDate}
                                on:input={(event) =>
                                  setRemediationDraft(
                                    row,
                                    "saleDate",
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                            <label>
                              Reconstruction note
                              <input
                                value={remediationDraft(row).note}
                                placeholder="e.g. sold at Japan Festival 2025"
                                on:input={(event) =>
                                  setRemediationDraft(
                                    row,
                                    "note",
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                            <button
                              type="button"
                              class="copy-button"
                              disabled={pendingRemediations[
                                remediationKey(row)
                              ]}
                              on:click={() => reconstructMissingReceipt(row)}
                            >
                              {pendingRemediations[remediationKey(row)]
                                ? "Saving..."
                                : "Reconstruct"}
                            </button>
                          {/if}
                          {#if canReconstructLateScan(row)}
                            <label>
                              Reconstruction note
                              <input
                                value={remediationDraft(row).note}
                                placeholder="e.g. move late scan to order receipt"
                                on:input={(event) =>
                                  setRemediationDraft(
                                    row,
                                    "note",
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                            <button
                              type="button"
                              class="copy-button"
                              disabled={pendingRemediations[
                                remediationKey(row)
                              ]}
                              on:click={() => reconstructLateScanReceipt(row)}
                            >
                              {pendingRemediations[remediationKey(row)]
                                ? "Saving..."
                                : "Induce order receipt"}
                            </button>
                          {/if}
                          {#if canMarkNotReceived(row)}
                            <label>
                              Not accepted note
                              <input
                                value={notReceivedDraft(row).note}
                                placeholder="e.g. rejected from inventory"
                                on:input={(event) =>
                                  setNotReceivedDraft(
                                    row,
                                    event.currentTarget.value,
                                  )}
                              />
                            </label>
                            <button
                              type="button"
                              class="copy-button"
                              disabled={pendingRemediations[
                                remediationKey(row)
                              ]}
                              on:click={() => markNotReceived(row)}
                            >
                              {pendingRemediations[remediationKey(row)]
                                ? "Saving..."
                                : "Not accepted/received"}
                            </button>
                          {/if}
                        </div>
                      {:else}
                        <span class="hint">-</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    {/each}
  {:else}
    <p class="hint">No stock order match issues match the current filters.</p>
  {/if}

  <h2>Audit Adjustments</h2>
  {#if filteredAuditRows.length > 0}
    <div class="table-section">
      <div class="table-summary">
        <div>
          <strong>Audit Adjustments</strong>
          <span>{filteredAuditRows.length} row(s)</span>
        </div>
        <button
          type="button"
          class="copy-button twisty-button"
          on:click={toggleAuditAdjustments}
        >
          {showAuditAdjustments ? "v Hide" : "> Show"}
        </button>
        <button
          type="button"
          class="copy-button"
          on:click={() =>
            copyTsv(
              "Audit Adjustments TSV",
              auditAdjustmentsTsv(filteredAuditRows),
            )}
        >
          Copy TSV
        </button>
      </div>
      <div class:hidden={!showAuditAdjustments}>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Date</th>
              <th>Kind</th>
              <th>Current qty</th>
              <th>Original qty</th>
              <th>Reduced by</th>
              <th>Source</th>
              <th>Audit comment</th>
              <th>Cost ledger</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredAuditRows as row (`audit:${row.key}:${row.ledgerIndex}:${row.at}:${row.seq}:${row.lotQty}`)}
              <tr
                class:audit-warning={row.auditSeverity === "warning"}
                class:audit-danger={row.auditSeverity === "danger"}
              >
                <td>
                  <a
                    href={`/itemhistory?itemKey=${encodeURIComponent(row.key)}`}
                  >
                    <strong>{row.key}</strong>
                  </a>
                  <div>{row.description}</div>
                  {#if row.subtype}
                    <span class="hint">{row.subtype}</span>
                  {/if}
                </td>
                <td>{fmtDate(row.at)}</td>
                <td>{row.kind}</td>
                <td>{fmtQty(row.lotQty)}</td>
                <td>{fmtQty(row.originalQty)}</td>
                <td>{fmtQty(row.reducedQty)}</td>
                <td>{row.source || "-"}</td>
                <td>{row.auditComment}</td>
                <td class="ledger-cell">
                  {#each row.ledger as entry, index}
                    <div class:target-entry={index === row.ledgerIndex}>
                      {ledgerEntryLabel(entry)}
                    </div>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {:else}
    <p class="hint">No audit adjustments match the current filters.</p>
  {/if}
</main>

<style>
  main {
    padding: 1rem;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0 0 1rem;
  }
  h2 {
    font-size: 1.1rem;
    margin: 1.25rem 0 0.5rem;
  }
  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 1rem;
    margin: 0;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .summary > div {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    min-width: 8rem;
  }
  .summary strong {
    display: block;
    font-size: 1.15rem;
  }
  .summary span,
  .hint {
    color: #666;
    font-size: 0.85rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    margin: 0 0 0.5rem;
  }
  label input:not([type]) {
    margin-left: 0.5rem;
    min-width: 20rem;
  }
  .chk input {
    margin-right: 0.35rem;
  }
  .order-issue-section {
    margin-top: 1rem;
  }
  .order-issue-section p {
    margin: 0.25rem 0 0;
  }
  .table-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 0.65rem;
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
    margin-top: 0.65rem;
    background: #f8f9fa;
  }
  .table-summary strong,
  .table-summary span {
    display: block;
  }
  .copy-button:hover {
    background: #e9ecef;
  }
  .copy-button {
    border: 1px solid #ced4da;
    border-radius: 4px;
    background: #fff;
    color: #212529;
    cursor: pointer;
  }
  .copy-button {
    padding: 0.35rem 0.55rem;
    white-space: nowrap;
  }
  .twisty-button {
    min-width: 4.75rem;
  }
  .copy-status {
    color: #495057;
    font-size: 0.85rem;
    margin: 0.5rem 0 0;
  }
  .hidden {
    display: none;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1rem;
  }
  th,
  td {
    border: 1px solid #dee2e6;
    padding: 0.45rem 0.6rem;
    text-align: left;
    vertical-align: top;
    font-size: 0.9rem;
  }
  th {
    background: #f8f9fa;
  }
  tr.missingExchange {
    background: #fffaf0;
  }
  tr.audit-warning {
    background: #fff8db;
  }
  tr.audit-danger {
    background: #ffe8ee;
  }
  tr.order-value-mismatch {
    background: #fff8db;
  }
  tr.stock-order-unmatched {
    background: #fff8db;
  }
  tr.stock-order-overmatched {
    background: #ffe8ee;
  }
  tr.stock-order-late {
    background: #fffaf0;
  }
  .thumb-cell {
    width: 72px;
  }
  .ledger-cell {
    min-width: 18rem;
    max-width: 28rem;
    font-family:
      ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono",
      monospace;
    font-size: 0.78rem;
    line-height: 1.35;
  }
  .target-entry {
    color: #b42318;
    font-weight: 600;
  }
  .issue {
    display: inline-block;
    border-radius: 999px;
    padding: 0.15rem 0.45rem;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .issue.unpriced-scan {
    color: #842029;
    background: #f8d7da;
  }
  .issue.missing-exchange {
    color: #7a4d00;
    background: #fff3cd;
  }
  .issue.unmatched-row {
    color: #7a4d00;
    background: #fff3cd;
  }
  .issue.overmatched-row {
    color: #842029;
    background: #f8d7da;
  }
  .issue.late-scan {
    color: #7a4d00;
    background: #fff3cd;
  }
  .remediation-form {
    display: grid;
    gap: 0.4rem;
    min-width: 14rem;
  }
  .remediation-form label {
    display: grid;
    gap: 0.15rem;
    color: #495057;
    font-size: 0.78rem;
  }
  .remediation-form input {
    min-width: 12rem;
    border: 1px solid #ced4da;
    border-radius: 4px;
    padding: 0.3rem 0.4rem;
    font: inherit;
  }
  .remediation-link {
    display: inline-block;
    text-align: center;
    text-decoration: none;
  }
  .copy-button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  .no-thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    color: #adb5bd;
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }
  a {
    color: #0066cc;
  }
</style>
