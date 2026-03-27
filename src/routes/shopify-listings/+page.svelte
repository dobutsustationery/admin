<script lang="ts">
  import { onDestroy } from "svelte";
  import { firestore } from "$lib/firebase";
  import { formatLogTimestamp } from "$lib/format-log-timestamp";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import {
    addDoc,
    collection,
    limit,
    onSnapshot,
    query,
    serverTimestamp,
    where,
  } from "firebase/firestore";

  type RowStatus = "admin_only" | "shopify_only" | "both";
  type DriftStatus = "unknown" | "in_sync" | "local_ahead" | "shopify_ahead";
  type ViewFilter =
    | "ALL"
    | "ADMIN_ONLY"
    | "SHOPIFY_ONLY"
    | "ADMIN_AHEAD"
    | "SHOPIFY_AHEAD"
    | "SYNCED";
  interface ShopifyAuditHandle {
    updatedAtIso: string;
    updatedAtMs: number;
  }
  interface ListingPresenceRow {
    handle: string;
    status: RowStatus;
    inAdmin: boolean;
    inShopify: boolean;
    adminLastUpdatedMs: number;
    shopifyLastUpdatedMs: number;
    shopifyUpdatedAtIso: string;
    drift: DriftStatus;
  }
  type TableStatus =
    | "admin_only"
    | "shopify_only"
    | "admin_ahead"
    | "shopify_ahead"
    | "synced";
  const SKEW_MS = 3 * 60_000;
  let lastDecisionFingerprint = "";

  const STATUS_PRIORITY: Record<RowStatus, number> = {
    admin_only: 0,
    shopify_only: 1,
    both: 2,
  };

  let isLoading = false;
  let error = "";
  let activeFilter: ViewFilter = "ALL";
  let requestedAtLabel = "";
  let lastCompletedAtLabel = "";
  let shopifyHandles: string[] = [];
  let shopifyHandleDataByNormalized: Record<string, ShopifyAuditHandle> = {};
  let unsubscribeAuditResult: (() => void) | null = null;
  let auditResultTimeout: ReturnType<typeof setTimeout> | null = null;
  let hasRequestedInitial = false;

  function normalizeHandle(value: string): string {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isLocallyValidListing(handle: string): boolean {
    const state = store.getState();
    const listingsState = state.listings || {};
    const inventoryState = state.inventory || {};

    const listing = listingsState.handleToListing?.[handle];
    if (!listing) return false;

    const title = String(listing.title || "").trim();
    const hasDescription = !!title && title.toLowerCase() !== "untitled";

    const category = String(listing.productCategory || "").trim();
    const knownCategories = Array.isArray(listingsState.knownCategories)
      ? listingsState.knownCategories
      : [];
    const hasValidCategory = !!category && knownCategories.includes(category);

    const idToHandle = listingsState.idToHandle || {};
    const idToItem = inventoryState.idToItem || {};
    const itemIdsForHandle = Object.entries(idToHandle)
      .filter(([_, h]) => String(h || "").trim() === handle)
      .map(([id]) => id);

    const hasValidPrice = itemIdsForHandle.some((id) => {
      const item = idToItem[id];
      const price = Number(item?.price || 0);
      return Number.isFinite(price) && price > 0;
    });

    return hasDescription && hasValidCategory && hasValidPrice;
  }

  function getAdminHandles(): string[] {
    const handleToListing = store.getState().listings?.handleToListing || {};
    const unique = new Map<string, string>();
    Object.keys(handleToListing).forEach((raw) => {
      const normalized = normalizeHandle(raw);
      if (!normalized) return;
      if (!isLocallyValidListing(raw)) return;
      if (!unique.has(normalized)) unique.set(normalized, String(raw).trim());
    });
    return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
  }

  function classifyDrift(
    status: RowStatus,
    adminLastUpdatedMs: number,
    shopifyLastUpdatedMs: number,
  ): DriftStatus {
    if (status !== "both") return "unknown";
    if (!adminLastUpdatedMs || !shopifyLastUpdatedMs) return "unknown";
    const delta = adminLastUpdatedMs - shopifyLastUpdatedMs;
    if (Math.abs(delta) <= SKEW_MS) return "in_sync";
    return delta > 0 ? "local_ahead" : "shopify_ahead";
  }

  function toDebugDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    return new Date(ms).toISOString();
  }

  function shouldLogDriftDecisions(): boolean {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).has(
      "debugShopifyListings",
    );
  }

  function logDriftDecisions(rows: ListingPresenceRow[]): void {
    if (!shouldLogDriftDecisions()) return;
    if (!rows.length) return;

    const fingerprint = rows
      .map(
        (row) =>
          `${row.handle}|${row.status}|${row.adminLastUpdatedMs}|${row.shopifyLastUpdatedMs}|${row.shopifyUpdatedAtIso}|${row.drift}`,
      )
      .join(";");
    if (fingerprint === lastDecisionFingerprint) return;
    lastDecisionFingerprint = fingerprint;

    console.groupCollapsed(
      `[ShopifyListingsDebug] Drift decisions (${rows.length} handles, skew=${SKEW_MS}ms)`,
    );
    rows.forEach((row) => {
      const parsedShopifyMs = row.shopifyUpdatedAtIso
        ? Date.parse(row.shopifyUpdatedAtIso)
        : NaN;
      const deltaMs = row.adminLastUpdatedMs - row.shopifyLastUpdatedMs;
      console.log({
        handle: row.handle,
        status: row.status,
        drift: row.drift,
        skewMs: SKEW_MS,
        deltaMs,
        deltaMinutes:
          Number.isFinite(deltaMs) && row.shopifyLastUpdatedMs > 0
            ? Math.round((deltaMs / 60_000) * 100) / 100
            : null,
        adminLastUpdatedMs: row.adminLastUpdatedMs,
        adminUpdatedAtIsoUtc: toDebugDate(row.adminLastUpdatedMs),
        shopifyUpdatedAtIsoRaw: row.shopifyUpdatedAtIso,
        shopifyLastUpdatedMs: row.shopifyLastUpdatedMs,
        shopifyUpdatedAtIsoUtc: toDebugDate(row.shopifyLastUpdatedMs),
        parsedShopifyMsFromIso: Number.isFinite(parsedShopifyMs)
          ? parsedShopifyMs
          : null,
        parsedShopifyIsoUtc: Number.isFinite(parsedShopifyMs)
          ? toDebugDate(parsedShopifyMs)
          : null,
        parseMatchesStoredMs: Number.isFinite(parsedShopifyMs)
          ? parsedShopifyMs === row.shopifyLastUpdatedMs
          : null,
      });
    });
    console.groupEnd();
  }

  function buildRows(
    adminHandles: string[],
    remoteHandles: string[],
  ): ListingPresenceRow[] {
    const handleToListing = store.getState().listings?.handleToListing || {};
    const adminByKey = new Map<string, string>();
    const shopifyByKey = new Map<string, string>();

    adminHandles.forEach((handle) => {
      const key = normalizeHandle(handle);
      if (key && !adminByKey.has(key)) adminByKey.set(key, handle);
    });
    remoteHandles.forEach((handle) => {
      const key = normalizeHandle(handle);
      if (key && !shopifyByKey.has(key)) shopifyByKey.set(key, handle);
    });

    const keys = new Set<string>([
      ...Array.from(adminByKey.keys()),
      ...Array.from(shopifyByKey.keys()),
    ]);

    return Array.from(keys)
      .map((key) => {
        const inAdmin = adminByKey.has(key);
        const inShopify = shopifyByKey.has(key);
        const handle = adminByKey.get(key) || shopifyByKey.get(key) || key;
        const listing = inAdmin ? handleToListing[handle] : null;
        const adminLastUpdatedMs = Number(listing?.lastUpdated || 0);
        const shopifyLastUpdatedMs = Number(
          shopifyHandleDataByNormalized[key]?.updatedAtMs || 0,
        );
        const shopifyUpdatedAtIso = String(
          shopifyHandleDataByNormalized[key]?.updatedAtIso || "",
        ).trim();
        const status: RowStatus =
          inAdmin && inShopify
            ? "both"
            : inAdmin
              ? "admin_only"
              : "shopify_only";
        const drift = classifyDrift(
          status,
          adminLastUpdatedMs,
          shopifyLastUpdatedMs,
        );
        return {
          handle,
          status,
          inAdmin,
          inShopify,
          adminLastUpdatedMs,
          shopifyLastUpdatedMs,
          shopifyUpdatedAtIso,
          drift,
        };
      })
      .sort((a, b) => {
        const statusDelta =
          STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
        if (statusDelta !== 0) return statusDelta;
        const aHasAdmin = a.inAdmin && a.adminLastUpdatedMs > 0;
        const bHasAdmin = b.inAdmin && b.adminLastUpdatedMs > 0;
        if (aHasAdmin || bHasAdmin) {
          const delta = b.adminLastUpdatedMs - a.adminLastUpdatedMs;
          if (delta !== 0) return delta;
        }
        return a.handle.localeCompare(b.handle);
      });
  }

  function getTableStatus(row: ListingPresenceRow): TableStatus {
    if (row.status === "admin_only") return "admin_only";
    if (row.status === "shopify_only") return "shopify_only";
    if (row.drift === "local_ahead") return "admin_ahead";
    if (row.drift === "shopify_ahead") return "shopify_ahead";
    return "synced";
  }

  function formatTableStatus(status: TableStatus): string {
    return status.replace("_", " ");
  }

  $: adminHandles = getAdminHandles();
  $: rows = buildRows(adminHandles, shopifyHandles);
  $: logDriftDecisions(rows);
  $: summary = {
    adminOnly: rows.filter((r) => r.status === "admin_only").length,
    shopifyOnly: rows.filter((r) => r.status === "shopify_only").length,
    adminAhead: rows.filter(
      (r) => r.status === "both" && r.drift === "local_ahead",
    ).length,
    shopifyAhead: rows.filter(
      (r) => r.status === "both" && r.drift === "shopify_ahead",
    ).length,
    synced: rows.filter(
      (r) =>
        r.status === "both" && (r.drift === "in_sync" || r.drift === "unknown"),
    ).length,
  };
  $: visibleRows = rows.filter((row) => {
    if (activeFilter === "ALL") return true;
    if (activeFilter === "ADMIN_ONLY") return row.status === "admin_only";
    if (activeFilter === "SHOPIFY_ONLY") return row.status === "shopify_only";
    if (activeFilter === "ADMIN_AHEAD")
      return row.status === "both" && row.drift === "local_ahead";
    if (activeFilter === "SHOPIFY_AHEAD")
      return row.status === "both" && row.drift === "shopify_ahead";
    if (activeFilter === "SYNCED")
      return (
        row.status === "both" &&
        (row.drift === "in_sync" || row.drift === "unknown")
      );
    return true;
  });

  function watchAuditResult(requestId: string) {
    if (unsubscribeAuditResult) unsubscribeAuditResult();
    if (auditResultTimeout) clearTimeout(auditResultTimeout);

    const settleFromDocs = (docs: any[]) => {
      const sorted = docs.sort(
        (a, b) =>
          Number(b?.createdAtMs || b?.requestedAt || 0) -
          Number(a?.createdAtMs || a?.requestedAt || 0),
      );
      for (const data of sorted) {
        const eventType = String(data?.eventType || "");
        if (eventType === "shopify/listings_audit_completed") {
          const handles = Array.isArray(data?.payload?.shopifyHandles)
            ? data.payload.shopifyHandles
                .map((h: any) => String(h || "").trim())
                .filter(Boolean)
            : [];
          const byHandleRaw =
            data?.payload?.shopifyByHandle &&
            typeof data.payload.shopifyByHandle === "object"
              ? data.payload.shopifyByHandle
              : {};
          const normalizedByHandle: Record<string, ShopifyAuditHandle> = {};
          for (const [rawHandle, rawValue] of Object.entries(byHandleRaw)) {
            const key = normalizeHandle(rawHandle);
            if (!key) continue;
            const value = rawValue as any;
            normalizedByHandle[key] = {
              updatedAtIso: String(value?.updatedAtIso || "").trim(),
              updatedAtMs: Number(value?.updatedAtMs || 0),
            };
          }
          shopifyHandles = handles;
          shopifyHandleDataByNormalized = normalizedByHandle;
          lastCompletedAtLabel = formatLogTimestamp(Date.now());
          isLoading = false;
          error = "";
          if (unsubscribeAuditResult) {
            unsubscribeAuditResult();
            unsubscribeAuditResult = null;
          }
          if (auditResultTimeout) {
            clearTimeout(auditResultTimeout);
            auditResultTimeout = null;
          }
          return true;
        }
        if (eventType === "shopify/listings_audit_failed") {
          error =
            String(data?.payload?.errorMessage || "").trim() ||
            "Shopify listings audit failed.";
          isLoading = false;
          if (unsubscribeAuditResult) {
            unsubscribeAuditResult();
            unsubscribeAuditResult = null;
          }
          if (auditResultTimeout) {
            clearTimeout(auditResultTimeout);
            auditResultTimeout = null;
          }
          return true;
        }
      }
      return false;
    };

    const unsubs: Array<() => void> = [];
    const stopAll = () => {
      while (unsubs.length) {
        const u = unsubs.pop();
        if (u) u();
      }
    };
    unsubscribeAuditResult = stopAll;

    const byRequestId = query(
      collection(firestore, "sync"),
      where("requestId", "==", requestId),
      limit(20),
    );
    const byRequestEventId = query(
      collection(firestore, "sync"),
      where("requestEventId", "==", requestId),
      limit(20),
    );

    unsubs.push(
      onSnapshot(
        byRequestId,
        (snap) => {
          const docs = snap.docs.map((d) => d.data() as any);
          settleFromDocs(docs);
        },
        (err) => {
          error = err?.message || "Failed to listen for audit results.";
          isLoading = false;
          stopAll();
          unsubscribeAuditResult = null;
        },
      ),
    );
    unsubs.push(
      onSnapshot(
        byRequestEventId,
        (snap) => {
          const docs = snap.docs.map((d) => d.data() as any);
          settleFromDocs(docs);
        },
        (err) => {
          error = err?.message || "Failed to listen for audit results.";
          isLoading = false;
          stopAll();
          unsubscribeAuditResult = null;
        },
      ),
    );

    auditResultTimeout = setTimeout(() => {
      if (!isLoading) return;
      isLoading = false;
      error = `Timed out waiting for Shopify listings audit result (${requestId}).`;
      stopAll();
      unsubscribeAuditResult = null;
      auditResultTimeout = null;
    }, 120000);
  }

  async function runAudit() {
    if (!$user?.uid || isLoading) return;
    isLoading = true;
    error = "";

    try {
      const requestDoc = await addDoc(
        collection(firestore, "request_shopify_listing_audit"),
        {
          eventType: "shopify/listings_audit_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "shopify-listings-page",
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      requestedAtLabel = formatLogTimestamp(Date.now());
      watchAuditResult(requestDoc.id);
    } catch (e: any) {
      error = e?.message || "Failed to request Shopify listings audit.";
      isLoading = false;
    }
  }

  $: if ($user?.uid && !hasRequestedInitial) {
    hasRequestedInitial = true;
    runAudit();
  }

  onDestroy(() => {
    if (unsubscribeAuditResult) unsubscribeAuditResult();
    if (auditResultTimeout) clearTimeout(auditResultTimeout);
  });
</script>

<svelte:head>
  <title>Shopify Listings</title>
</svelte:head>

<div class="page">
  <div class="header">
    <div>
      <h1>Shopify Listings</h1>
      <p class="subtext">
        MVP handle audit with timestamp drift comparison (SKEW_MS = {SKEW_MS}).
      </p>
    </div>
    <button
      class="btn-refresh"
      on:click={runAudit}
      disabled={!$user || isLoading}
    >
      {#if isLoading}
        Checking…
      {:else}
        Refresh Audit
      {/if}
    </button>
  </div>

  {#if !$user}
    <div class="alert">Sign in to run Shopify listings audit.</div>
  {:else}
    <div class="summary-dashboard">
      <button
        class="summary-card all"
        class:active={activeFilter === "ALL"}
        on:click={() => (activeFilter = "ALL")}
      >
        <span class="label">All</span>
        <span class="value">{rows.length}</span>
      </button>
      <button
        class="summary-card admin"
        class:active={activeFilter === "ADMIN_ONLY"}
        on:click={() => (activeFilter = "ADMIN_ONLY")}
      >
        <span class="label">Admin Only</span>
        <span class="value">{summary.adminOnly}</span>
      </button>
      <button
        class="summary-card shopify"
        class:active={activeFilter === "SHOPIFY_ONLY"}
        on:click={() => (activeFilter = "SHOPIFY_ONLY")}
      >
        <span class="label">Shopify Only</span>
        <span class="value">{summary.shopifyOnly}</span>
      </button>
      <button
        class="summary-card admin-ahead"
        class:active={activeFilter === "ADMIN_AHEAD"}
        on:click={() => (activeFilter = "ADMIN_AHEAD")}
      >
        <span class="label">Admin Ahead</span>
        <span class="value">{summary.adminAhead}</span>
      </button>
      <button
        class="summary-card shopify-ahead"
        class:active={activeFilter === "SHOPIFY_AHEAD"}
        on:click={() => (activeFilter = "SHOPIFY_AHEAD")}
      >
        <span class="label">Shopify Ahead</span>
        <span class="value">{summary.shopifyAhead}</span>
      </button>
      <button
        class="summary-card synced"
        class:active={activeFilter === "SYNCED"}
        on:click={() => (activeFilter = "SYNCED")}
      >
        <span class="label">Synced</span>
        <span class="value">{summary.synced}</span>
      </button>
    </div>

    <div class="meta">
      {#if requestedAtLabel}<span>Last requested: {requestedAtLabel}</span>{/if}
      {#if lastCompletedAtLabel}
        <span>Last completed: {lastCompletedAtLabel}</span>
      {/if}
    </div>

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Handle</th>
            <th>Status</th>
            <th>Admin Updated</th>
            <th>Shopify Updated</th>
          </tr>
        </thead>
        <tbody>
          {#if visibleRows.length === 0}
            <tr>
              <td colspan="4" class="empty">No rows for current filter.</td>
            </tr>
          {:else}
            {#each visibleRows as row}
              <tr>
                <td class="mono">
                  <a
                    class="handle-link"
                    href={`/listing-detail?handle=${encodeURIComponent(row.handle)}`}
                  >
                    {row.handle}
                  </a>
                </td>
                <td>
                  <span class="badge {getTableStatus(row)}">
                    {formatTableStatus(getTableStatus(row))}
                  </span>
                </td>
                <td>
                  {row.adminLastUpdatedMs > 0
                    ? formatLogTimestamp(row.adminLastUpdatedMs)
                    : "-"}
                </td>
                <td>
                  {row.shopifyLastUpdatedMs > 0
                    ? formatLogTimestamp(row.shopifyLastUpdatedMs)
                    : "-"}
                </td>
              </tr>
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.25rem;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  h1 {
    margin: 0;
    font-size: 1.5rem;
  }

  .subtext {
    margin: 0.25rem 0 0;
    color: #4b5563;
    font-size: 0.95rem;
  }

  .btn-refresh {
    background: #0b57d0;
    color: white;
    border: 0;
    border-radius: 8px;
    padding: 0.55rem 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }

  .btn-refresh:disabled {
    opacity: 0.65;
    cursor: not-allowed;
  }

  .alert {
    background: #fef3c7;
    border: 1px solid #f59e0b;
    color: #92400e;
    padding: 0.75rem;
    border-radius: 8px;
  }

  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .summary-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }

  .summary-card {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: #fff;
    padding: 0.55rem 0.65rem;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      transform 0.08s ease;
  }

  .summary-card:hover {
    transform: translateY(-1px);
  }

  .summary-card .label {
    display: block;
    font-size: 0.75rem;
    color: #4b5563;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .summary-card .value {
    display: block;
    font-size: 1.2rem;
    font-weight: 800;
    line-height: 1.1;
    margin-top: 0.12rem;
  }

  .summary-card.active {
    box-shadow: inset 0 0 0 2px #111827;
  }

  .summary-card.admin {
    background: #fee2e2;
    color: #991b1b;
  }

  .summary-card.shopify {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .summary-card.admin-ahead {
    background: #dcfce7;
    color: #166534;
  }

  .summary-card.shopify-ahead {
    background: #ecfdf5;
    color: #065f46;
  }

  .summary-card.synced {
    background: #fff7ed;
    color: #9a3412;
  }

  .summary-card.all {
    background: #f3f4f6;
    color: #111827;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    color: #6b7280;
    font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }

  .error {
    margin-bottom: 0.75rem;
    background: #fee2e2;
    color: #991b1b;
    border: 1px solid #fca5a5;
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
  }

  .table-wrap {
    overflow: auto;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: white;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 640px;
  }

  th,
  td {
    text-align: left;
    border-bottom: 1px solid #f3f4f6;
    padding: 0.6rem 0.75rem;
    font-size: 0.92rem;
  }

  th {
    background: #f9fafb;
    color: #374151;
    position: sticky;
    top: 0;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .handle-link {
    color: #0b57d0;
    text-decoration: none;
    font-weight: 600;
  }

  .handle-link:hover {
    text-decoration: underline;
  }

  .badge {
    display: inline-block;
    border-radius: 999px;
    font-size: 0.76rem;
    font-weight: 700;
    padding: 0.2rem 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.01em;
  }

  .badge.admin_only {
    background: #fee2e2;
    color: #991b1b;
  }

  .badge.shopify_only {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .badge.admin_ahead {
    background: #dcfce7;
    color: #166534;
  }

  .badge.shopify_ahead {
    background: #ecfdf5;
    color: #065f46;
  }

  .badge.synced {
    background: #fff7ed;
    color: #9a3412;
  }

  .empty {
    color: #6b7280;
    text-align: center;
    padding: 1rem;
  }
</style>
