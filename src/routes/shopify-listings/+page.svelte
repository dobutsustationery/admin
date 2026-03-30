<script lang="ts">
  import { firestore } from "$lib/firebase";
  import { formatLogTimestamp } from "$lib/format-log-timestamp";
  import { diffLocalListingAgainstShopifyCatalog } from "$lib/shopify-deep-diff";
  import type { ShopifyCatalogListing } from "$lib/shopify-catalog-slice";
  import { store } from "$lib/store";
  import { SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION } from "$lib/sync-events";
  import { user } from "$lib/user-store";
  import { addDoc, collection, serverTimestamp } from "firebase/firestore";

  type RowStatus = "admin_only" | "shopify_only" | "both";
  type DriftStatus = "unknown" | "in_sync" | "local_ahead" | "shopify_ahead";
  type ViewFilter =
    | "ALL"
    | "ADMIN_ONLY"
    | "SHOPIFY_ONLY"
    | "ADMIN_AHEAD"
    | "SHOPIFY_AHEAD"
    | "DEEP_DIFF"
    | "SYNCED";
  interface ListingPresenceRow {
    handle: string;
    status: RowStatus;
    inAdmin: boolean;
    inShopify: boolean;
    adminLastUpdatedMs: number;
    shopifyLastUpdatedMs: number;
    shopifyUpdatedAtIso: string;
    drift: DriftStatus;
    deepDiff: boolean;
    mismatchKeys: string[];
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
  let activeRequestId = "";
  let hasRequestedInitial = false;

  function normalizeHandle(value: string): string {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isLocallyValidListing(state: any, handle: string): boolean {
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

  function getAdminHandles(state: any): string[] {
    const handleToListing = state.listings?.handleToListing || {};
    const unique = new Map<string, string>();
    Object.keys(handleToListing).forEach((raw) => {
      const normalized = normalizeHandle(raw);
      if (!normalized) return;
      if (!isLocallyValidListing(state, raw)) return;
      if (!unique.has(normalized)) unique.set(normalized, String(raw).trim());
    });
    return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
  }

  function getRemoteHandles(state: any): string[] {
    const handleToListing = state.shopifyCatalog?.handleToListing || {};
    const unique = new Map<string, string>();
    Object.keys(handleToListing).forEach((raw) => {
      const normalized = normalizeHandle(raw);
      if (!normalized) return;
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
          `${row.handle}|${row.status}|${row.adminLastUpdatedMs}|${row.shopifyLastUpdatedMs}|${row.shopifyUpdatedAtIso}|${row.drift}|${row.deepDiff}|${row.mismatchKeys.join(",")}`,
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
        deepDiff: row.deepDiff,
        mismatchKeys: row.mismatchKeys,
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

  function getItemsForHandle(state: any, handle: string) {
    const idToHandle = state.listings?.idToHandle || {};
    const idToItem = state.inventory?.idToItem || {};
    return Object.entries(idToHandle)
      .filter(
        ([_, listingHandle]) => String(listingHandle || "").trim() === handle,
      )
      .map(([id]) => idToItem[id])
      .filter(Boolean);
  }

  function buildRows(
    state: any,
    adminHandles: string[],
    remoteHandles: string[],
  ): ListingPresenceRow[] {
    const handleToListing = state.listings?.handleToListing || {};
    const shopifyHandleToListing = state.shopifyCatalog?.handleToListing || {};
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
        const remoteHandle = shopifyByKey.get(key) || "";
        const remoteListing: ShopifyCatalogListing | null = remoteHandle
          ? shopifyHandleToListing[remoteHandle]
          : null;
        const adminLastUpdatedMs = Number(listing?.lastUpdated || 0);
        const shopifyLastUpdatedMs = Number(remoteListing?.updatedAtMs || 0);
        const shopifyUpdatedAtIso = String(
          remoteListing?.updatedAtIso || "",
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

        let deepDiff = false;
        let mismatchKeys: string[] = [];
        if (status === "both" && listing && remoteListing) {
          const result = diffLocalListingAgainstShopifyCatalog({
            handle,
            listing,
            items: getItemsForHandle(state, handle),
            remoteListing,
          });
          deepDiff = !result.matches;
          mismatchKeys = result.mismatchKeys;
        }

        return {
          handle,
          status,
          inAdmin,
          inShopify,
          adminLastUpdatedMs,
          shopifyLastUpdatedMs,
          shopifyUpdatedAtIso,
          drift,
          deepDiff,
          mismatchKeys,
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

  async function requestCatalogSync(forceFull = false) {
    if (!$user?.uid || isLoading) return;
    isLoading = true;
    error = "";

    try {
      const catalogState = store.getState().shopifyCatalog || {};
      const requestDoc = await addDoc(
        collection(firestore, SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION),
        {
          eventType: "shopify/catalog_sync_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "shopify-listings-page",
          forceFull,
          sinceUpdatedAtMs: forceFull
            ? 0
            : Number(catalogState.maxUpdatedAtMs || 0),
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      requestedAtLabel = formatLogTimestamp(Date.now());
      activeRequestId = requestDoc.id;
    } catch (e: any) {
      error = e?.message || "Failed to request Shopify catalog sync.";
      isLoading = false;
    }
  }

  $: currentState = $store;
  $: catalogState = currentState.shopifyCatalog || {};
  $: adminHandles = getAdminHandles(currentState);
  $: remoteHandles = getRemoteHandles(currentState);
  $: rows = buildRows(currentState, adminHandles, remoteHandles);
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
    deepDiff: rows.filter((r) => r.deepDiff).length,
    synced: rows.filter(
      (r) =>
        r.status === "both" &&
        !r.deepDiff &&
        (r.drift === "in_sync" || r.drift === "unknown"),
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
    if (activeFilter === "DEEP_DIFF") return row.deepDiff;
    if (activeFilter === "SYNCED")
      return (
        row.status === "both" &&
        !row.deepDiff &&
        (row.drift === "in_sync" || row.drift === "unknown")
      );
    return true;
  });
  $: lastCompletedAtLabel =
    catalogState.lastSyncCompletedAtMs > 0
      ? formatLogTimestamp(catalogState.lastSyncCompletedAtMs)
      : "";
  $: lastCursorLabel =
    catalogState.maxUpdatedAtMs > 0
      ? formatLogTimestamp(catalogState.maxUpdatedAtMs)
      : "";
  $: staleError =
    !activeRequestId &&
    Number(catalogState.lastSyncFailedAtMs || 0) >
      Number(catalogState.lastSyncCompletedAtMs || 0)
      ? String(catalogState.lastSyncError || "").trim()
      : "";
  $: effectiveError = error || staleError;

  $: if (activeRequestId) {
    if (catalogState.lastAppliedRequestId === activeRequestId) {
      isLoading = false;
      error = "";
      activeRequestId = "";
    } else if (catalogState.lastFailedRequestId === activeRequestId) {
      isLoading = false;
      error =
        String(catalogState.lastSyncError || "").trim() ||
        "Shopify catalog sync failed.";
      activeRequestId = "";
    }
  }

  $: if ($user?.uid && !hasRequestedInitial) {
    hasRequestedInitial = true;
    requestCatalogSync(!catalogState.hasCompletedFullSync);
  }
</script>

<svelte:head>
  <title>Shopify Listings</title>
</svelte:head>

<div class="page">
  <div class="header">
    <div>
      <h1>Shopify Listings</h1>
      <p class="subtext">
        Replay-backed Shopify shadow catalog with incremental sync and deep diff
        badges. Full refresh is still needed to reconcile deletions.
      </p>
    </div>
    <div class="actions">
      <button
        class="btn-refresh secondary"
        on:click={() => requestCatalogSync(true)}
        disabled={!$user || isLoading}
      >
        Full Refresh
      </button>
      <button
        class="btn-refresh"
        on:click={() => requestCatalogSync(false)}
        disabled={!$user || isLoading}
      >
        {#if isLoading}
          Syncing…
        {:else}
          Refresh Sync
        {/if}
      </button>
    </div>
  </div>

  {#if !$user}
    <div class="alert">Sign in to sync Shopify catalog state.</div>
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
        class="summary-card deep-diff"
        class:active={activeFilter === "DEEP_DIFF"}
        on:click={() => (activeFilter = "DEEP_DIFF")}
      >
        <span class="label">Deep Diff</span>
        <span class="value">{summary.deepDiff}</span>
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
      {#if lastCompletedAtLabel}<span
          >Last completed: {lastCompletedAtLabel}</span
        >{/if}
      {#if lastCursorLabel}<span>Catalog cursor: {lastCursorLabel}</span>{/if}
      <span>Mode: {catalogState.lastSyncMode || "not synced yet"}</span>
    </div>

    {#if effectiveError}
      <div class="error">{effectiveError}</div>
    {/if}

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Handle</th>
            <th>Status</th>
            <th>Deep Diff</th>
            <th>Admin Updated</th>
            <th>Shopify Updated</th>
          </tr>
        </thead>
        <tbody>
          {#if visibleRows.length === 0}
            <tr>
              <td colspan="5" class="empty">No rows for current filter.</td>
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
                  {#if row.deepDiff}
                    <a
                      class="badge deep_diff diff-link"
                      href={`/shopify-listings/diff?handle=${encodeURIComponent(row.handle)}`}
                      title={row.mismatchKeys.join(", ")}
                    >
                      {row.mismatchKeys.length} mismatch{row.mismatchKeys
                        .length === 1
                        ? ""
                        : "es"}
                    </a>
                  {:else if row.status === "both"}
                    <span class="badge match">match</span>
                  {:else}
                    -
                  {/if}
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

  .actions {
    display: flex;
    gap: 0.5rem;
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

  .btn-refresh.secondary {
    background: #e5e7eb;
    color: #111827;
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

  .summary-card.deep-diff {
    background: #fef3c7;
    color: #92400e;
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
    min-width: 760px;
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

  .badge.deep_diff {
    background: #fef3c7;
    color: #92400e;
  }

  .badge.match {
    background: #e0f2fe;
    color: #075985;
  }

  .diff-link {
    text-decoration: none;
  }

  .diff-link:hover {
    filter: brightness(0.97);
  }

  .empty {
    color: #6b7280;
    text-align: center;
    padding: 1rem;
  }
</style>
