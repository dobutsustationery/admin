<script lang="ts">
  import { page } from "$app/stores";
  import { tick } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { fix_stock_order, type StockOrderMeta } from "$lib/inventory";
  import { getAllCachedActions } from "$lib/action-cache";
  import { rootReducer } from "$lib/root-reducer";
  import { toTimestampMs } from "$lib/timestamped-action";
  import { set_stock_order_scan_batch_audit } from "$lib/ui-slice";
  import {
    buildStockOrderScannerAudit,
    selectOrderExceptions,
    previewStockOrderFix,
    stockOrderCostColumns,
    type OrderExceptionRow,
    type StockOrderScanBatchAuditRow,
    type StockOrderScanBatchExpectedRow,
    type StockOrderScanBatchExtraRow,
    type StockOrderScanBatchScan,
    type StockOrderScanBatchOrderRef,
    type StockOrderUnmatchedScanDaySummary,
    type StockOrderCostMatchRow,
  } from "$lib/order-exceptions";

  $: orderId = $page.url.searchParams.get("orderId");
  $: rows = selectOrderExceptions($store.inventory);
  $: exceptions = rows.filter((r) => r.isException);
  $: current = orderId ? rows.find((r) => r.orderId === orderId) : undefined;
  $: currentScanAudit = current
    ? scanAuditRows.find((r) => r.orderId === current?.orderId)
    : undefined;
  $: scanAuditGeneratedAt = $store.ui.stockOrderScanBatchAudit?.generatedAt;
  $: visibleScanAuditRows = showAllScanAuditRows
    ? scanAuditRows
    : scanAuditRows.filter((r) => r.unusualCount > 0);
  $: unusualScanAuditCount = scanAuditRows.filter(
    (r) => r.unusualCount > 0,
  ).length;

  let statusMessage = "";
  let scanAuditRows: StockOrderScanBatchAuditRow[] = [];
  $: scanAuditRows = $store.ui.stockOrderScanBatchAudit?.rows || [];
  let unmatchedScanDays: StockOrderUnmatchedScanDaySummary[] = [];
  $: unmatchedScanDays =
    $store.ui.stockOrderScanBatchAudit?.unmatchedScanDays || [];
  let expandedUnmatchedJanDays = new Set<string>();
  let expandedFoundOrderDays = new Set<string>();
  let scanAuditLoading = false;
  let scanAuditProgress = 0;
  let scanAuditTotal = 0;
  let scanAuditMessage = "";
  let showAllScanAuditRows = false;
  const REPLAY_YIELD_EVERY = 500;

  // One atomic edit: all fields feed a single proposed fix.
  let dateStr = "";
  let goodsJpy = "";
  let expectedItemCount = "";
  let orderJpy = "";
  let paidAmount = "";
  let paidCurrency: "EUR" | "BGN" = "EUR";
  let costPaste = "";
  let overrideExisting = false;
  let approveDiscrepancy = false;
  let ignoreUnmatchedRows = false;
  let fixCountryOfOrigin = false;
  let fixWeights = false;
  const weightToleranceOptions = [0, 0.1, 1, 5, 10];
  let weightToleranceG = 0;
  let resolutionFilter = "all";
  let manualOverride = false;
  let manualKind: "unit" | "total" = "total";
  let manualCostColumnIndex = -1;
  let manualQtyColumnIndex = -1;
  let manualCountryColumnIndex = -1;
  let manualWeightColumnIndex = -1;

  let lastLoadedOrder = "";
  $: if (current && current.orderId !== lastLoadedOrder) {
    lastLoadedOrder = current.orderId;
    manualOverride = false;
    dateStr =
      current.receivedAt && current.receivedAt > 0
        ? new Date(current.receivedAt).toISOString().slice(0, 10)
        : "";
    goodsJpy = current.valueOfGoodsJpy?.toString() ?? "";
    expectedItemCount = current.expectedItemCount?.toString() ?? "";
    orderJpy = current.valueOfOrderJpy?.toString() ?? "";
    paidAmount = current.paidAmount?.toString() ?? "";
    paidCurrency = current.paidCurrency ?? "EUR";
    costPaste = "";
    overrideExisting = false;
    approveDiscrepancy = false;
    ignoreUnmatchedRows = false;
    fixCountryOfOrigin = false;
    fixWeights = true;
    weightToleranceG = 0;
    resolutionFilter = "all";
    manualCostColumnIndex = -1;
    manualQtyColumnIndex = -1;
    manualCountryColumnIndex = -1;
    manualWeightColumnIndex = -1;
  }

  function num(s: string): number | undefined {
    const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) && s.trim() !== "" ? n : undefined;
  }

  $: proposedMeta = (() => {
    const m: StockOrderMeta = {};
    if (dateStr) {
      const ms = Date.parse(dateStr + "T00:00:00Z");
      if (Number.isFinite(ms)) m.receivedAt = ms;
    }
    const g = num(goodsJpy);
    const c = num(expectedItemCount);
    const o = num(orderJpy);
    const p = num(paidAmount);
    if (g != null) m.valueOfGoodsJpy = g;
    if (c != null) m.expectedItemCount = c;
    if (o != null) m.valueOfOrderJpy = o;
    if (p != null) {
      m.paidAmount = p;
      m.paidCurrency = paidCurrency;
    }
    return m;
  })();

  $: hasMeta = Object.values(proposedMeta).some((v) => v !== undefined);
  $: valueOfGoodsJpy = proposedMeta.valueOfGoodsJpy ?? current?.valueOfGoodsJpy;
  $: expectedItems =
    proposedMeta.expectedItemCount ?? current?.expectedItemCount;
  // Columns + auto-detected interpretation for the manual dropdowns.
  $: costCols = costPaste.trim()
    ? stockOrderCostColumns(costPaste, valueOfGoodsJpy, expectedItems)
    : {
        columns: [],
        headerRows: 1,
        auto: null,
        countryColumnIndex: -1,
        weightColumnIndex: -1,
      };
  // Default the manual selectors to the same goods-aware auto pick used by
  // the preview whenever the user has not taken manual control.
  $: if (!manualOverride && costCols.auto) {
    manualKind = costCols.auto.kind;
    manualCostColumnIndex = costCols.auto.costColumnIndex;
    manualQtyColumnIndex = costCols.auto.qtyColumnIndex;
  }
  // COO/weight follow the auto-detected columns until the user takes
  // manual control, so the dropdowns always show the chosen column.
  $: if (!manualOverride) {
    manualCountryColumnIndex = costCols.countryColumnIndex ?? -1;
    manualWeightColumnIndex = costCols.weightColumnIndex ?? -1;
  }
  $: interpretation =
    manualOverride && manualCostColumnIndex >= 0 && manualQtyColumnIndex >= 0
      ? {
          kind: manualKind,
          costColumnIndex: manualCostColumnIndex,
          qtyColumnIndex: manualQtyColumnIndex,
          countryColumnIndex: manualCountryColumnIndex,
          weightColumnIndex: manualWeightColumnIndex,
        }
      : undefined;
  $: persistedCostInterpretation =
    manualOverride && interpretation
      ? interpretation
      : costCols.auto
        ? {
            ...costCols.auto,
            countryColumnIndex: manualCountryColumnIndex,
            weightColumnIndex: manualWeightColumnIndex,
          }
        : undefined;
  $: fixPreview = current
    ? previewStockOrderFix($store.inventory, current.orderId, {
        meta: proposedMeta,
        rawPaste: costPaste,
        overrideExisting,
        approveDiscrepancy,
        interpretation,
        ignoreUnmatchedRows,
        weightToleranceG: Number(weightToleranceG),
      })
    : null;
  $: matchRows = fixPreview?.matchRows ?? [];
  $: hasUnmatchedRows = matchRows.some((r) => r.isUnmatched);
  $: hasValueDiscrepancy =
    fixPreview?.reconciliation?.discrepancy != null &&
    fixPreview.reconciliation.discrepancy !== 0;
  $: valueDiscrepancy = fixPreview?.reconciliation?.discrepancy ?? 0;
  $: hasItemCountDiscrepancy =
    fixPreview?.reconciliation?.itemCountDiscrepancy != null &&
    fixPreview.reconciliation.itemCountDiscrepancy !== 0;
  $: itemCountDiscrepancy =
    fixPreview?.reconciliation?.itemCountDiscrepancy ?? 0;
  $: hasCountryOfOriginFixes = matchRows.some((r) => r.canFixCountryOfOrigin);
  $: hasWeightFixes = matchRows.some((r) => r.canFixWeight);
  $: hasCountryOfOriginWarnings = matchRows.some(
    (r) => r.countryOfOriginMismatch,
  );
  $: hasWeightWarnings = matchRows.some((r) => r.weightMismatch);
  $: if (!hasCountryOfOriginFixes) fixCountryOfOrigin = false;
  $: resolutionKinds = [
    "all",
    ...Array.from(new Set(matchRows.flatMap((r) => r.kinds))),
  ];
  $: if (!resolutionKinds.includes(resolutionFilter)) resolutionFilter = "all";
  $: filteredMatchRows =
    resolutionFilter === "all"
      ? matchRows
      : matchRows.filter((r) => rowHasKind(r, resolutionFilter));
  $: nothingToDo = !hasMeta && !costPaste.trim();
  $: commitDisabled = !fixPreview || nothingToDo || fixPreview.blocked;

  function broadcastAction(action: any): boolean {
    if (!$user?.uid) {
      statusMessage = "Sign in before saving changes.";
      return false;
    }
    broadcast(firestore, $user.uid, action);
    return true;
  }

  function commitFix() {
    if (!current || commitDisabled) return;
    if (
      broadcastAction(
        fix_stock_order({
          orderId: current.orderId,
          meta: proposedMeta,
          costTsv: costPaste.trim() ? costPaste : undefined,
          costInterpretation: costPaste.trim()
            ? persistedCostInterpretation
            : undefined,
          costInterpretationMode: costPaste.trim()
            ? manualOverride
              ? "manual"
              : "auto"
            : undefined,
          overrideExisting,
          approveDiscrepancy,
          ignoreUnmatchedRows,
          fixCountryOfOrigin,
          fixWeights,
        }),
      )
    )
      statusMessage = "Order fix committed.";
  }

  function fmt(n: number | undefined, digits = 2): string {
    return n == null ? "—" : Number(n).toFixed(digits);
  }
  function cooText(row: StockOrderCostMatchRow): string {
    const current = row.item?.countryOfOrigin || "—";
    return row.incomingCountryOfOrigin
      ? `${current} -> ${row.incomingCountryOfOrigin}`
      : current;
  }
  function weightText(row: StockOrderCostMatchRow): string {
    const current = row.item?.weight ? `${row.item.weight}g` : "—";
    return row.incomingWeight
      ? `${current} -> ${row.incomingWeight}g`
      : current;
  }
  function uniqueOrderRows(rows: StockOrderCostMatchRow[]) {
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.rowIndex}:${row.jan}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function sumOrderQty(rows: StockOrderCostMatchRow[]): number {
    return uniqueOrderRows(rows).reduce((s, row) => s + row.qty, 0);
  }
  function sumOrderLineCost(rows: StockOrderCostMatchRow[]): number {
    return uniqueOrderRows(rows).reduce((s, row) => s + row.lineCostJpy, 0);
  }

  let copyMsg = "";
  function breakdownTsv(): string {
    const r = fixPreview?.reconciliation?.chosen;
    if (!r) return "";
    const rows = filteredMatchRows.length ? filteredMatchRows : matchRows;
    const lines = [
      [
        "Image",
        "JAN",
        "Item",
        "Inventory Key",
        "Status",
        "Qty",
        "UnitJPY",
        "LineJPY",
        "COO",
        "Weight",
      ].join("\t"),
    ];
    let totQty = 0;
    let totLine = 0;
    for (const row of rows) {
      totQty += row.qty;
      totLine += row.lineCostJpy;
      lines.push(
        [
          row.item?.image || "",
          row.jan,
          row.item?.description || "",
          row.key || "",
          row.status,
          row.qty,
          row.unitCostJpy,
          row.lineCostJpy,
          cooText(row),
          weightText(row),
        ].join("\t"),
      );
    }
    lines.push(
      ["TOTAL", "", "", "", "", totQty, "", totLine, "", ""].join("\t"),
    );
    lines.push(
      [
        "VALUE OF GOODS",
        "",
        "",
        "",
        "",
        "",
        "",
        Number(goodsJpy) || current?.valueOfGoodsJpy || "",
        "",
        "",
      ].join("\t"),
    );
    return lines.join("\n");
  }
  async function copyBreakdown() {
    try {
      await navigator.clipboard.writeText(breakdownTsv());
      copyMsg = "Copied TSV to clipboard.";
    } catch {
      copyMsg = "Clipboard blocked — select the table manually.";
    }
  }
  function dateLabel(r: OrderExceptionRow): string {
    return r.flags.dateUnknown
      ? "⚠ unknown"
      : new Date(r.receivedAt as number).toISOString().slice(0, 10);
  }
  function filterLabel(kind: string): string {
    return kind.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  function rowHasKind(row: { kinds: string[] }, kind: string): boolean {
    return row.kinds.includes(kind);
  }
  function filterCount(kind: string): number {
    return kind === "all"
      ? matchRows.length
      : matchRows.filter((row) => rowHasKind(row, kind)).length;
  }
  function actionTimestampSortKey(action: any): number {
    const ms =
      toTimestampMs(action?.timestamp) ??
      (typeof action?._timestamp_millis === "number"
        ? action._timestamp_millis
        : typeof action?._timestamp === "number"
          ? action._timestamp
          : 0);
    const nanos =
      typeof action?.timestamp?.nanoseconds === "number"
        ? action.timestamp.nanoseconds
        : typeof action?.timestamp?._nanoseconds === "number"
          ? action.timestamp._nanoseconds
          : 0;
    return ms + nanos / 1_000_000_000;
  }
  async function runScanBatchAudit() {
    scanAuditLoading = true;
    scanAuditProgress = 0;
    scanAuditTotal = 0;
    scanAuditMessage = "Loading cached broadcast actions...";
    try {
      const actions = await getAllCachedActions();
      const replayActions = [...actions].sort(
        (a, b) => actionTimestampSortKey(a) - actionTimestampSortKey(b),
      );
      scanAuditTotal = replayActions.length;
      scanAuditMessage = `Replaying ${scanAuditTotal.toLocaleString()} actions...`;
      await tick();

      let replayState = rootReducer(undefined, { type: "@@INIT" });
      for (let i = 0; i < replayActions.length; i++) {
        try {
          replayState = rootReducer(replayState, replayActions[i], () => {});
        } catch (e) {
          console.warn("Scan batch audit replay error:", e);
        }
        if (
          (i + 1) % REPLAY_YIELD_EVERY === 0 ||
          i === replayActions.length - 1
        ) {
          scanAuditProgress = i + 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }

      scanAuditMessage = "Comparing order rows to scanner batches...";
      await tick();
      const audit = buildStockOrderScannerAudit(
        replayState.inventory,
        replayActions,
      );
      store.dispatch(
        set_stock_order_scan_batch_audit({
          generatedAt: Date.now(),
          rows: audit.rows,
          unmatchedScanDays: audit.unmatchedScanDays,
        }),
      );
      scanAuditMessage = `Audited ${audit.rows.length.toLocaleString()} zeroed-quantity stock order(s).`;
    } catch (e) {
      console.error("Failed to run scan batch audit:", e);
      scanAuditMessage =
        e instanceof Error ? e.message : "Failed to run scan batch audit.";
    } finally {
      scanAuditLoading = false;
    }
  }
  function scanBatchDateRange(row: StockOrderScanBatchAuditRow): string {
    if (!row.startAt || !row.endAt) return "No matching scans";
    const start = new Date(row.startAt).toISOString().slice(0, 10);
    const end = new Date(row.endAt - 1).toISOString().slice(0, 10);
    const core = start === end ? start : `${start} to ${end}`;
    if (row.stragglerScanCount && row.stragglerEndAt) {
      const stragglerEnd = new Date(row.stragglerEndAt - 1)
        .toISOString()
        .slice(0, 10);
      return `${core} · +${row.stragglerScanCount} expected late scan(s) through ${stragglerEnd}`;
    }
    return core;
  }
  function scanTime(scan: StockOrderScanBatchScan): string {
    return new Date(scan.at).toISOString().replace("T", " ").slice(0, 16);
  }
  function generatedAtLabel(ms: number | undefined): string {
    return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "";
  }
  function orderRowsLabel(row: StockOrderScanBatchExpectedRow): string {
    return row.rows.join(", ");
  }
  function firstScanLabel(
    row: StockOrderScanBatchExpectedRow | StockOrderScanBatchExtraRow,
  ): string {
    const scan = row.scans[0];
    return scan ? `${scanTime(scan)} · ${scan.description}` : "—";
  }
  function unmatchedOrderRefs(
    row: StockOrderUnmatchedScanDaySummary,
    jan: string,
  ): StockOrderScanBatchOrderRef[] {
    return (
      (row.unmatchedJanOrderRefs || []).find((entry) => entry.jan === jan)
        ?.orders ?? []
    );
  }
  function unmatchedFoundOrderRefs(row: StockOrderUnmatchedScanDaySummary): {
    jan: string;
    orders: StockOrderScanBatchOrderRef[];
  }[] {
    return row.unmatchedJans
      .map((jan) => ({ jan, orders: unmatchedOrderRefs(row, jan) }))
      .filter((entry) => entry.orders.length > 0);
  }
  function toggledSet(set: Set<string>, key: string): Set<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }
  function toggleUnmatchedJans(date: string): void {
    expandedUnmatchedJanDays = toggledSet(expandedUnmatchedJanDays, date);
  }
  function toggleFoundOrders(date: string): void {
    expandedFoundOrderDays = toggledSet(expandedFoundOrderDays, date);
  }
  function visibleUnmatchedJans(
    row: StockOrderUnmatchedScanDaySummary,
  ): string[] {
    if (
      expandedUnmatchedJanDays.has(row.date) ||
      row.unmatchedJans.length <= 20
    ) {
      return row.unmatchedJans;
    }
    return row.unmatchedJans.slice(0, 19);
  }
  function hiddenUnmatchedJanCount(
    row: StockOrderUnmatchedScanDaySummary,
  ): number {
    if (
      expandedUnmatchedJanDays.has(row.date) ||
      row.unmatchedJans.length <= 20
    ) {
      return 0;
    }
    return row.unmatchedJans.length - 19;
  }
  function visibleFoundOrderRefs(row: StockOrderUnmatchedScanDaySummary): {
    jan: string;
    orders: StockOrderScanBatchOrderRef[];
  }[] {
    const entries = unmatchedFoundOrderRefs(row);
    if (expandedFoundOrderDays.has(row.date) || entries.length <= 5) {
      return entries;
    }
    return entries.slice(0, 4);
  }
  function hiddenFoundOrderCount(
    row: StockOrderUnmatchedScanDaySummary,
  ): number {
    const entries = unmatchedFoundOrderRefs(row);
    if (expandedFoundOrderDays.has(row.date) || entries.length <= 5) return 0;
    return entries.length - 4;
  }
</script>

<svelte:head><title>Order Exceptions</title></svelte:head>

{#if !current}
  <h1>Order Exceptions</h1>
  {#if statusMessage}<p class="status">{statusMessage}</p>{/if}
  {#if exceptions.length === 0}
    <p class="all-clear">✓ All stock orders are complete — no exceptions.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Order</th><th>Receipt date</th><th>Goods ¥</th>
          <th>Order ¥</th><th>Paid €</th><th>Lots</th><th>Needs cost</th>
          <th>Gaps</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each exceptions as r (r.orderId)}
          <tr>
            <td>{r.name}</td>
            <td class:warn={r.flags.dateUnknown}>{dateLabel(r)}</td>
            <td class:warn={r.flags.goodsValueUnknown}
              >{fmt(r.valueOfGoodsJpy, 0)}</td
            >
            <td class:warn={r.flags.orderValueUnknown}
              >{fmt(r.valueOfOrderJpy, 0)}</td
            >
            <td class:warn={r.flags.paidUnknown}>{fmt(r.totalOrderEur)}</td>
            <td>{r.lotCount}</td>
            <td class:warn={r.flags.needsCost}>{r.unpricedCount}</td>
            <td>
              {[
                r.flags.dateUnknown && "date",
                r.flags.goodsValueUnknown && "goods",
                r.flags.orderValueUnknown && "order",
                r.flags.paidUnknown && "paid",
                r.flags.needsCost && "cost",
              ]
                .filter(Boolean)
                .join(", ")}
            </td>
            <td>
              <a
                href={`/order-exceptions?orderId=${encodeURIComponent(r.orderId)}`}
                >Fix Order →</a
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <section>
    <h2>Scanner Batch Audit</h2>
    <p class="hint">
      Replays cached broadcast actions and compares each stock order's rows to
      the scanner batch window that best matches that order. Only
      zeroed-quantity imports are audited, because normal receipt imports are
      not expected to have a matching scan batch. This is manual because full
      replay is intentionally expensive.
    </p>
    <button on:click={runScanBatchAudit} disabled={scanAuditLoading}>
      {scanAuditLoading ? "Running audit..." : "Run scanner batch audit"}
    </button>
    {#if scanAuditMessage}
      <p class="hint">
        {scanAuditMessage}
        {#if scanAuditLoading && scanAuditTotal > 0}
          ({scanAuditProgress.toLocaleString()} / {scanAuditTotal.toLocaleString()})
        {/if}
      </p>
    {/if}
    {#if scanAuditRows.length}
      {#if scanAuditGeneratedAt}
        <p class="hint">
          Report generated {generatedAtLabel(scanAuditGeneratedAt)}. Re-run the
          audit if cached action history has changed.
        </p>
      {/if}
      {#if unmatchedScanDays.length}
        <h3>Unmatched Scan Days</h3>
        <table class="scan-audit-table">
          <thead>
            <tr>
              <th class="scan-date-col">Date</th><th>Unmatched scans</th><th
                >Matched scans</th
              >
              <th>Unmatched qty</th><th>Matched qty</th><th>Unmatched JANs</th>
              <th class="found-orders-col">Found in orders</th>
            </tr>
          </thead>
          <tbody>
            {#each unmatchedScanDays as row (row.date)}
              <tr class:warning-row={true}>
                <td class="scan-date-col">{row.date}</td>
                <td>{row.unmatchedScanCount}</td>
                <td>{row.matchedScanCount}</td>
                <td>{row.unmatchedQty}</td>
                <td>{row.matchedQty}</td>
                <td>
                  <div class="link-list">
                    {#each visibleUnmatchedJans(row) as jan (jan)}
                      <a
                        href={`/itemhistory?itemKey=${encodeURIComponent(jan)}`}
                        >{jan}</a
                      >
                    {/each}
                    {#if hiddenUnmatchedJanCount(row) > 0}
                      <button
                        type="button"
                        class="link-button"
                        on:click={() => toggleUnmatchedJans(row.date)}
                      >
                        Show {hiddenUnmatchedJanCount(row)} more
                      </button>
                    {/if}
                  </div>
                </td>
                <td class="found-orders-col">
                  <div class="order-ref-list">
                    {#each visibleFoundOrderRefs(row) as entry (entry.jan)}
                      <div>
                        <span>{entry.jan}:</span>
                        {#each entry.orders as ref, i (ref.orderId)}
                          {#if i > 0},
                          {/if}
                          <a
                            href={`/order-exceptions?orderId=${encodeURIComponent(ref.orderId)}`}
                            title={ref.name}>{ref.label}</a
                          >
                        {/each}
                      </div>
                    {/each}
                    {#if hiddenFoundOrderCount(row) > 0}
                      <button
                        type="button"
                        class="link-button"
                        on:click={() => toggleFoundOrders(row.date)}
                      >
                        Show {hiddenFoundOrderCount(row)} more
                      </button>
                    {/if}
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      <label class="chk">
        <input type="checkbox" bind:checked={showAllScanAuditRows} />
        Show orders with no unusual findings
      </label>
      <p class="preview">
        {unusualScanAuditCount} order(s) with unusual scanner-batch findings ·
        {scanAuditRows.length} zeroed-quantity order(s) audited.
      </p>
      <table class="scan-audit-table">
        <thead>
          <tr>
            <th>Order</th><th>Batch</th><th>Coverage</th><th>Missing / short</th
            >
            <th>Over</th><th>Extra</th><th></th>
          </tr>
        </thead>
        <tbody>
          {#each visibleScanAuditRows as row (row.orderId)}
            <tr class:warning-row={row.unusualCount > 0}>
              <td>{row.name}</td>
              <td>{scanBatchDateRange(row)}</td>
              <td>
                {row.scannedUniqueOrderJans} / {row.expectedUniqueJans} JANs ·
                {row.scannedOrderQty} / {row.expectedQty} units ·
                {row.scanCount} scan(s)
              </td>
              <td>{row.missingOrShort.length}</td>
              <td>{row.overScanned.length}</td>
              <td>{row.extraScans.length}</td>
              <td>
                <a
                  href={`/order-exceptions?orderId=${encodeURIComponent(row.orderId)}`}
                  >Review</a
                >
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
{:else}
  <a class="back" href="/order-exceptions">← All exceptions</a>
  <h1>Fix Order: {current.name}</h1>
  {#if statusMessage}<p class="status">{statusMessage}</p>{/if}
  <p class="hint">
    Fill any of the fields below — receipt date, the money facts, and/or the
    invoice cost TSV — then commit once. They apply together as a single atomic
    change; order does not matter (the TSV reconciles against the value of goods
    you enter here).
  </p>

  <section>
    <h2>Scanner Batch Audit</h2>
    <p class="hint">
      Replays cached broadcast actions and compares this order's rows to the
      scanner batch window that best matches it. Only zeroed-quantity imports
      are audited, because normal receipt imports are not expected to have a
      matching scan batch.
    </p>
    <button on:click={runScanBatchAudit} disabled={scanAuditLoading}>
      {scanAuditLoading ? "Running audit..." : "Run scanner batch audit"}
    </button>
    {#if scanAuditMessage}
      <p class="hint">
        {scanAuditMessage}
        {#if scanAuditLoading && scanAuditTotal > 0}
          ({scanAuditProgress.toLocaleString()} / {scanAuditTotal.toLocaleString()})
        {/if}
      </p>
    {/if}
    {#if currentScanAudit}
      {#if scanAuditGeneratedAt}
        <p class="hint">
          Report generated {generatedAtLabel(scanAuditGeneratedAt)}. Re-run the
          audit if cached action history has changed.
        </p>
      {/if}
      <p class="preview">
        Batch {scanBatchDateRange(currentScanAudit)} ·
        {currentScanAudit.scannedUniqueOrderJans} / {currentScanAudit.expectedUniqueJans}
        JANs · {currentScanAudit.scannedOrderQty} / {currentScanAudit.expectedQty}
        units · {currentScanAudit.scanCount} scan(s).
      </p>

      {#if currentScanAudit.missingOrShort.length}
        <h3>Missing / Short in Batch</h3>
        <table class="scan-audit-table">
          <thead>
            <tr>
              <th>Rows</th><th>JAN</th><th>Expected</th><th>Scanned</th>
              <th>Gap</th><th>Unit ¥</th><th>Scans</th>
            </tr>
          </thead>
          <tbody>
            {#each currentScanAudit.missingOrShort as row (row.jan)}
              <tr
                class:error-row={row.scannedQty === 0}
                class:warning-row={row.scannedQty > 0}
              >
                <td>{orderRowsLabel(row)}</td>
                <td
                  ><a href={`/itemhistory?itemKey=${row.jan}`}>{row.jan}</a></td
                >
                <td>{row.expectedQty}</td>
                <td>{row.scannedQty}</td>
                <td>{row.gap}</td>
                <td>{row.unitCosts.join(", ")}</td>
                <td>{firstScanLabel(row)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if currentScanAudit.overScanned.length}
        <h3>Overrepresented in Batch</h3>
        <table class="scan-audit-table">
          <thead>
            <tr>
              <th>Rows</th><th>JAN</th><th>Expected</th><th>Scanned</th>
              <th>Over</th><th>Unit ¥</th><th>Scans</th>
            </tr>
          </thead>
          <tbody>
            {#each currentScanAudit.overScanned as row (row.jan)}
              <tr class:warning-row={true}>
                <td>{orderRowsLabel(row)}</td>
                <td
                  ><a href={`/itemhistory?itemKey=${row.jan}`}>{row.jan}</a></td
                >
                <td>{row.expectedQty}</td>
                <td>{row.scannedQty}</td>
                <td>{Math.abs(row.gap)}</td>
                <td>{row.unitCosts.join(", ")}</td>
                <td>{firstScanLabel(row)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if currentScanAudit.extraScans.length}
        <h3>Scans Not in This Order</h3>
        <table class="scan-audit-table">
          <thead>
            <tr><th>JAN</th><th>Qty</th><th>First scan</th></tr>
          </thead>
          <tbody>
            {#each currentScanAudit.extraScans as row (row.jan)}
              <tr class:warning-row={true}>
                <td
                  ><a href={`/itemhistory?itemKey=${row.jan}`}>{row.jan}</a></td
                >
                <td>{row.scannedQty}</td>
                <td>{firstScanLabel(row)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      {#if currentScanAudit.unusualCount === 0}
        <p class="all-clear">
          No unusual scanner-batch findings for this order.
        </p>
      {/if}
    {/if}
  </section>

  <section>
    <h2>Receipt date</h2>
    <input type="date" bind:value={dateStr} />

    <h2>Money facts (JPY) + paid amount</h2>
    <label>Value of goods (¥)<input bind:value={goodsJpy} /></label>
    <label>Expected item count<input bind:value={expectedItemCount} /></label>
    <label
      >Value of order (¥, incl. shipping/tax)<input
        bind:value={orderJpy}
      /></label
    >
    <label>
      Order paid
      <input bind:value={paidAmount} />
      <select bind:value={paidCurrency}>
        <option value="EUR">EUR</option>
        <option value="BGN">BGN (lev)</option>
      </select>
    </label>

    <h2>Missing costs — paste invoice TSV (JPY)</h2>
    <textarea
      bind:value={costPaste}
      rows="6"
      placeholder="JAN code&#9;UNIT PRICE (YEN)&#9;Quantity&#9;TOTAL (YEN)"
    ></textarea>
  </section>

  {#if fixPreview}
    {@const rc = fixPreview.reconciliation}
    <section>
      <h2>Preview — net effect of this one commit</h2>
      <p class="preview">
        {#if fixPreview.fx > 0}
          exchange = {fmt(fixPreview.fx, 6)} €/¥
        {:else}
          exchange not set (EUR pending)
        {/if}
        · {fixPreview.affectedLots} lot(s) in this order ·
        {fixPreview.items.length} item(s) re-derive cost.
      </p>

      {#if rc}
        <div class="breakdown">
          <label class="chk">
            <input type="checkbox" bind:checked={manualOverride} />
            Manually choose columns / approach
          </label>
          {#if manualOverride}
            <div class="manual">
              <label>
                Approach
                <select bind:value={manualKind}>
                  <option value="total">Total ÷ Count</option>
                  <option value="unit">Count × Unit price</option>
                </select>
              </label>
              <label>
                {manualKind === "total" ? "Total column" : "Unit price column"}
                <select bind:value={manualCostColumnIndex}>
                  {#each costCols.columns as c (c.index)}
                    <option value={c.index}>{c.label}</option>
                  {/each}
                </select>
              </label>
              <label>
                Count column
                <select bind:value={manualQtyColumnIndex}>
                  {#each costCols.columns as c (c.index)}
                    <option value={c.index}>{c.label}</option>
                  {/each}
                </select>
              </label>
              <label>
                Country of Origin column
                <select bind:value={manualCountryColumnIndex}>
                  <option value={-1}>— none —</option>
                  {#each costCols.columns as c (c.index)}
                    <option value={c.index}>{c.label}</option>
                  {/each}
                </select>
              </label>
              <label>
                Weight column
                <select bind:value={manualWeightColumnIndex}>
                  <option value={-1}>— none —</option>
                  {#each costCols.columns as c (c.index)}
                    <option value={c.index}>{c.label}</option>
                  {/each}
                </select>
              </label>
            </div>
          {/if}
        </div>

        {#if !rc.chosen}
          <p class="bad">
            Could not resolve the invoice columns (JAN + quantity + a
            cost/total). Check the paste.
          </p>
        {:else}
          <p>
            Invoice interpretation: <strong>{rc.chosen.label}</strong> ({rc
              .chosen.kind}) · Σ {fmt(rc.chosen.sum, 0)} ¥ vs goods {goodsJpy ||
              fmt(current.valueOfGoodsJpy, 0)} ¥ ·
            {#if rc.reconciled}
              <span class="ok">reconciled ✓</span>
            {:else if rc.discrepancy != null}
              <span class="bad"
                >discrepancy {rc.discrepancy > 0 ? "+" : ""}{fmt(
                  rc.discrepancy,
                  0,
                )} ¥</span
              >
            {:else}
              <span class="bad">enter value of goods to reconcile</span>
            {/if}
          </p>
          <p>
            Item count: parsed Σ {fmt(rc.qtySum, 0)} item(s)
            {#if expectedItems}
              vs expected {fmt(expectedItems, 0)}
              {#if rc.itemCountReconciled}
                <span class="ok">reconciled ✓</span>
              {:else if rc.itemCountDiscrepancy != null}
                <span class="bad"
                  >discrepancy {rc.itemCountDiscrepancy > 0 ? "+" : ""}{fmt(
                    rc.itemCountDiscrepancy,
                    0,
                  )}</span
                >
              {/if}
            {:else}
              <span class="bad">enter expected item count to reconcile</span>
            {/if}
          </p>
          {#if rc.candidates.length > 1}
            <p class="hint">
              Candidates (Σ per interpretation): {rc.candidates
                .map((c) => `${c.label}=${fmt(c.sum, 0)}`)
                .join(" · ")}
            </p>
          {/if}

          <div class="breakdown">
            <button class="copy" on:click={copyBreakdown}>
              Copy table as TSV
            </button>
            {#if copyMsg}<span class="hint">{copyMsg}</span>{/if}
            <label class="weight-threshold">
              Weight match threshold
              <select bind:value={weightToleranceG}>
                {#each weightToleranceOptions as g}
                  <option value={g}>{g}g</option>
                {/each}
              </select>
            </label>
            {#if resolutionKinds.length > 1}
              <div class="pills" aria-label="Filter match table">
                {#each resolutionKinds as kind (kind)}
                  <button
                    type="button"
                    class:active={resolutionFilter === kind}
                    on:click={() => (resolutionFilter = kind)}
                  >
                    {filterLabel(kind)}
                    <span>{filterCount(kind)}</span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if hasCountryOfOriginWarnings || hasWeightWarnings}
              <p class="warning-block">
                {#if hasCountryOfOriginWarnings}
                  Some rows have mismatched COO values between inventory and the
                  pasted order.
                {/if}
                {#if hasWeightWarnings}
                  Some rows have weight differences beyond the selected
                  threshold.
                {/if}
              </p>
            {/if}

            <table class="match-table">
              <thead>
                <tr>
                  <th>Image</th><th>JAN / Item</th><th>Status</th><th>Qty</th>
                  <th>Unit ¥</th><th>Line ¥</th><th>COO</th><th>Weight</th>
                </tr>
              </thead>
              <tbody>
                {#each filteredMatchRows as row (row.rowIndex + ":" + row.jan + ":" + (row.key || ""))}
                  <tr
                    class:error-row={row.isUnmatched}
                    class:fix-row={row.canFixCountryOfOrigin ||
                      row.canFixWeight}
                    class:warning-row={row.countryOfOriginMismatch ||
                      row.weightMismatch}
                  >
                    <td class="thumb-cell">
                      {#if row.item?.image}
                        <img
                          class="thumb"
                          src={row.item.image}
                          alt={row.item.description || row.jan}
                        />
                      {:else}
                        <span class="no-thumb">—</span>
                      {/if}
                    </td>
                    <td>
                      <strong>{row.jan}</strong>
                      {#if row.item}
                        <div>{row.item.description}</div>
                        {#if row.item.subtype}
                          <span class="hint">{row.item.subtype}</span>
                        {/if}
                        {#if row.key}<div class="hint">{row.key}</div>{/if}
                      {:else}
                        <div class="bad">No lot in this order</div>
                      {/if}
                    </td>
                    <td>
                      <span class="status-pill">{row.status}</span>
                      {#if row.canFixCountryOfOrigin}
                        <span class="status-pill fix">Fix COO</span>
                      {/if}
                      {#if row.canFixWeight}
                        <span class="status-pill fix">Fix Weight</span>
                      {/if}
                      {#if row.countryOfOriginMismatch || row.weightMismatch}
                        <span class="status-pill warn">Warning</span>
                      {/if}
                    </td>
                    <td>{row.qty}</td>
                    <td>{fmt(row.unitCostJpy, 0)}</td>
                    <td>{fmt(row.lineCostJpy, 0)}</td>
                    <td>
                      <span
                        class:bad={row.countryOfOriginMismatch}
                        class:ok={row.canFixCountryOfOrigin}
                      >
                        {cooText(row)}
                      </span>
                    </td>
                    <td>
                      <span
                        class:bad={row.weightMismatch}
                        class:ok={row.canFixWeight}
                      >
                        {weightText(row)}
                      </span>
                    </td>
                  </tr>
                {/each}
              </tbody>
              <tfoot>
                <tr class="total">
                  <td colspan="3"><strong>TOTAL</strong></td>
                  <td>{sumOrderQty(filteredMatchRows)}</td>
                  <td></td>
                  <td>
                    <strong
                      >{fmt(sumOrderLineCost(filteredMatchRows), 0)}</strong
                    >
                  </td>
                  <td></td>
                  <td></td>
                </tr>
                <tr>
                  <td colspan="5">Value of goods</td>
                  <td
                    >{goodsJpy || fmt(current.valueOfGoodsJpy, 0)}
                    {#if rc.discrepancy != null && rc.discrepancy !== 0}
                      <span class="bad"
                        >(Δ {rc.discrepancy > 0 ? "+" : ""}{fmt(
                          rc.discrepancy,
                          0,
                        )})</span
                      >
                    {/if}</td
                  >
                  <td></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p>
            {fixPreview.matched.length} lot(s) priced from TSV ·
            {fixPreview.unmatchedJans.length} TSV row(s) with no lot in this order
            ·
            {fixPreview.matched.filter((m) => m.isOverride).length} override existing
          </p>
          {#if fixPreview.unmatchedJans.length}
            <p class="error-summary">
              Unmatched: {fixPreview.unmatchedJans.join(", ")}
            </p>
          {/if}
          {#if fixPreview.matched.some((m) => m.isOverride)}
            <label class="chk">
              <input type="checkbox" bind:checked={overrideExisting} />
              Override lots that already have a cost
            </label>
          {/if}
          {#if hasValueDiscrepancy || hasItemCountDiscrepancy}
            <label class="chk">
              <input type="checkbox" bind:checked={approveDiscrepancy} />
              Approve despite
              {#if hasValueDiscrepancy}
                {valueDiscrepancy > 0 ? "+" : ""}{fmt(valueDiscrepancy, 0)} ¥ value
                discrepancy
              {/if}
              {#if hasValueDiscrepancy && hasItemCountDiscrepancy}
                and
              {/if}
              {#if hasItemCountDiscrepancy}
                {itemCountDiscrepancy > 0 ? "+" : ""}{fmt(
                  itemCountDiscrepancy,
                  0,
                )} item count discrepancy
              {/if}
            </label>
          {/if}
          {#if hasCountryOfOriginFixes}
            <label class="chk">
              <input type="checkbox" bind:checked={fixCountryOfOrigin} />
              Fix missing COO values from pasted order rows
            </label>
          {/if}
          {#if hasWeightFixes}
            <label class="chk">
              <input type="checkbox" bind:checked={fixWeights} />
              Fix missing weights from pasted order rows
            </label>
          {/if}
          {#if hasUnmatchedRows}
            <label class="chk danger">
              <input type="checkbox" bind:checked={ignoreUnmatchedRows} />
              Ignore unmatched rows and allow submit
            </label>
          {/if}
        {/if}
      {/if}

      {#if fixPreview.items.length}
        {@const eurKnown = fixPreview.fx > 0}
        {#if !eurKnown}
          <p class="hint">
            EUR cost is pending — it is computed only once <em
              >Value of order</em
            >
            and <em>Order paid</em> are entered (exchange = paid ÷ value of order).
            The JPY repricing below is final.
          </p>
        {/if}
        <table class="mini">
          <thead>
            <tr>
              <th>Item</th><th>cost ¥ old→new</th>
              <th>cost € old→new</th>
            </tr>
          </thead>
          <tbody>
            {#each fixPreview.items as it (it.key)}
              <tr>
                <td>{it.key}</td>
                <td>{fmt(it.oldCostJpy)} → {fmt(it.newCostJpy)}</td>
                <td>
                  {#if eurKnown}
                    {fmt(it.oldCostEur, 4)} → {fmt(it.newCostEur, 4)}
                  {:else}
                    <span class="hint">pending exchange</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <button on:click={commitFix} disabled={commitDisabled}>
        Commit all fixes
      </button>
      {#if nothingToDo}
        <p class="hint">Enter at least one field above.</p>
      {/if}
    </section>
  {/if}
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1rem 0;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0.8rem 0 0.3rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1rem 0;
  }
  th,
  td {
    border: 1px solid #dee2e6;
    padding: 0.4rem 0.6rem;
    text-align: left;
    font-size: 0.9rem;
  }
  .mini {
    width: auto;
  }
  .warn {
    background: #fff3cd;
    color: #856404;
    font-weight: 600;
  }
  .all-clear {
    color: #155724;
    background: #d4edda;
    padding: 1rem;
    border-radius: 4px;
  }
  .status {
    color: #155724;
  }
  .preview {
    background: #e7f3ff;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
  }
  section {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 1rem;
    margin: 1rem 0;
  }
  textarea {
    width: 100%;
    font-family: monospace;
    font-size: 0.85rem;
  }
  .hint {
    color: #666;
    font-size: 0.85rem;
  }
  .warning-block {
    color: #7a4b00;
    background: #fff3cd;
    border: 1px solid #ffda6a;
    padding: 0.55rem 0.7rem;
    border-radius: 4px;
    font-weight: 600;
  }
  .error-summary {
    color: #842029;
    background: #f8d7da;
    border: 1px solid #f1aeb5;
    padding: 0.6rem 0.75rem;
    border-radius: 4px;
    font-weight: 700;
  }
  .ok {
    color: #155724;
    font-weight: 600;
  }
  .bad {
    color: #842029;
    font-weight: 600;
  }
  .chk {
    display: block;
    margin: 0.3rem 0;
  }
  .chk input {
    margin-right: 0.4rem;
  }
  .chk.danger {
    color: #842029;
    font-weight: 700;
  }
  label {
    display: block;
    margin: 0.4rem 0;
  }
  label input,
  label select {
    margin-left: 0.5rem;
  }
  button {
    margin-top: 0.5rem;
    padding: 0.4rem 0.9rem;
  }
  .breakdown {
    margin: 0.5rem 0 1rem;
  }
  .manual {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    margin: 0.3rem 0 0.6rem;
  }
  .manual label {
    margin: 0;
  }
  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.55rem 0;
  }
  .weight-threshold {
    display: inline-block;
    margin: 0 0 0.55rem;
  }
  .pills button {
    margin: 0;
    border: 1px solid #ced4da;
    background: #fff;
    color: #343a40;
    border-radius: 999px;
    padding: 0.22rem 0.55rem;
    font-size: 0.8rem;
  }
  .pills button.active {
    border-color: #0066cc;
    background: #e7f3ff;
    color: #004f9e;
    font-weight: 700;
  }
  .pills span {
    margin-left: 0.3rem;
    color: #666;
  }
  .match-table {
    width: 100%;
  }
  .match-table td {
    vertical-align: top;
  }
  .thumb-cell {
    width: 56px;
  }
  .thumb {
    width: 44px;
    height: 44px;
    object-fit: cover;
    border-radius: 4px;
    border: 1px solid #dee2e6;
    background: #f8f9fa;
  }
  .no-thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    color: #adb5bd;
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }
  .status-pill {
    display: inline-block;
    margin: 0 0.25rem 0.25rem 0;
    padding: 0.12rem 0.4rem;
    border-radius: 999px;
    background: #e9ecef;
    color: #343a40;
    font-size: 0.75rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .status-pill.fix {
    background: #d1e7dd;
    color: #0f5132;
  }
  .status-pill.warn {
    background: #fff3cd;
    color: #664d03;
  }
  tr.error-row td {
    background: #f8d7da;
  }
  tr.fix-row td {
    background: #eaf6ef;
  }
  tr.warning-row td {
    background: #fff3cd;
  }
  tr.error-row.warning-row td {
    background: #f8d7da;
  }
  button.copy {
    margin: 0 0.5rem 0.3rem 0;
    font-size: 0.8rem;
    padding: 0.25rem 0.6rem;
  }
  .link-list,
  .order-ref-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem 0.6rem;
  }
  .order-ref-list {
    display: block;
  }
  .order-ref-list > div {
    margin-bottom: 0.25rem;
  }
  .scan-date-col {
    min-width: 7rem;
    width: 7.5rem;
  }
  .found-orders-col {
    min-width: 12rem;
    width: 14rem;
  }
  .link-button {
    border: 0;
    background: none;
    color: #0066cc;
    cursor: pointer;
    font: inherit;
    margin: 0;
    padding: 0;
    text-decoration: underline;
  }
  tr.total td {
    border-top: 2px solid #adb5bd;
    background: #f1f3f5;
  }
  .back {
    font-size: 0.85rem;
  }
  a {
    color: #0066cc;
  }
</style>
