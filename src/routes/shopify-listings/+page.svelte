<script lang="ts">
  import { firestore } from "$lib/firebase";
  import { formatLogTimestamp } from "$lib/format-log-timestamp";
  import {
    buildComparableRemoteListing,
    diffComparableShopifyListingsDetailed,
    type DetailedShopifyDiffResult,
    type VariantDiffDetail,
    type VariantDiffField,
  } from "$lib/shopify-deep-diff";
  import {
    buildAdminShopifyListingProjectionFromState,
    buildComparableAdminShopifySyncProjection,
    buildShopifySyncRequestEvent,
  } from "$lib/shopify-listing-projection";
  import ShopifyListingIssueDetail from "$lib/components/ShopifyListingIssueDetail.svelte";
  import type { ShopifyCatalogListing } from "$lib/shopify-catalog-slice";
  import { store } from "$lib/store";
  import {
    SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION,
    SHOPIFY_REQUEST_COLLECTION,
  } from "$lib/sync-events";
  import { user } from "$lib/user-store";
  import { addDoc, collection, serverTimestamp } from "firebase/firestore";

  type RowStatus = "admin_only" | "shopify_only" | "both";
  type DriftStatus = "unknown" | "in_sync" | "local_ahead" | "shopify_ahead";
  type IssueKey =
    | "presence"
    | "bare_sku"
    | "quantity"
    | "variant_image"
    | "gallery"
    | "status"
    | "category"
    | "price"
    | "weight"
    | "variant_structure"
    | "variant_identity"
    | "single_jan_subtype"
    | "metadata"
    | "timestamp_only"
    | "synced";
  type IssueFilter = "ACTIONABLE" | "ALL" | IssueKey;
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
    diffDetails: DetailedShopifyDiffResult | null;
    issueKeys: IssueKey[];
    primaryIssue: IssueKey;
  }
  type TableStatus =
    | "would_create"
    | "shopify_only"
    | "would_update"
    | "no_edit";

  const SKEW_MS = 3 * 60_000;
  let lastDecisionFingerprint = "";
  const ISSUE_PRIORITY: IssueKey[] = [
    "presence",
    "bare_sku",
    "quantity",
    "variant_image",
    "gallery",
    "status",
    "category",
    "price",
    "weight",
    "variant_structure",
    "variant_identity",
    "single_jan_subtype",
    "metadata",
    "timestamp_only",
    "synced",
  ];

  const ISSUE_LABELS: Record<IssueKey, string> = {
    presence: "Presence",
    bare_sku: "Bare Shopify SKU",
    quantity: "Inventory Quantity",
    variant_image: "Variant Image",
    gallery: "Product Images",
    status: "Status",
    category: "Category",
    price: "Price",
    weight: "Weight",
    variant_structure: "Variant Count",
    variant_identity: "Variant Identity",
    single_jan_subtype: "Single JAN Subtype",
    metadata: "Metadata",
    timestamp_only: "Timestamp Only",
    synced: "No Sync Edits",
  };

  const ISSUE_DESCRIPTIONS: Record<IssueKey, string> = {
    presence:
      "A sync would create the listing, or Shopify has no admin source.",
    bare_sku: "Shopify has bare JAN SKUs while admin expects JAN plus subtype.",
    quantity: "Shopify on-hand quantity differs from admin on-hand inventory.",
    variant_image: "A sync would change a variant image assignment.",
    gallery: "A sync would change Shopify product images.",
    status: "A sync would change Shopify listing status.",
    category: "A sync would change product category or product type.",
    price: "A sync would change variant price.",
    weight: "A sync would change variant weight.",
    variant_structure: "A sync would add or remove Shopify variants.",
    variant_identity: "Variant subtype, JAN, or non-bare SKU differs.",
    single_jan_subtype:
      "Variant matched by a unique JAN while subtype/SKU details differ.",
    metadata: "Title, body, option name, or other listing metadata differs.",
    timestamp_only:
      "Updated timestamps differ, but a sync would not change listing data.",
    synced: "Sync projection and Shopify data match.",
  };

  const STATUS_PRIORITY: Record<RowStatus, number> = {
    admin_only: 0,
    shopify_only: 1,
    both: 2,
  };

  let isLoading = false;
  let error = "";
  let activeFilter: IssueFilter = "ACTIONABLE";
  let requestedAtLabel = "";
  let activeRequestId = "";
  let hasRequestedInitial = false;
  let bulkSyncIssue: IssueKey | null = null;
  let bulkSyncMessage = "";

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

  function variantHasField(
    detail: VariantDiffDetail,
    field: VariantDiffField,
  ): boolean {
    return detail.fields.includes(field);
  }

  function isBareShopifySku(detail: VariantDiffDetail): boolean {
    const localSku = String(detail.local?.sku || "").trim();
    const localJan = String(detail.local?.janCode || "").trim();
    const remoteSku = String(detail.remote?.sku || "").trim();
    return (
      variantHasField(detail, "sku") &&
      !!localSku &&
      !!remoteSku &&
      /^\d+$/.test(remoteSku) &&
      (remoteSku === localJan || localSku.startsWith(remoteSku)) &&
      localSku !== remoteSku
    );
  }

  function variantDiffCount(
    row: ListingPresenceRow,
    field: VariantDiffField,
  ): number {
    return (row.diffDetails?.variantDiffs || []).filter((detail) =>
      variantHasField(detail, field),
    ).length;
  }

  function bareSkuCount(row: ListingPresenceRow): number {
    return bareSkuRows(row).length;
  }

  function bareSkuRows(row: ListingPresenceRow): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail) => detail.matchType !== "singleJan" && isBareShopifySku(detail),
    );
  }

  function missingVariantCount(row: ListingPresenceRow): number {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail) =>
        detail.matchType === "missingLocal" ||
        detail.matchType === "missingRemote",
    ).length;
  }

  function fieldDiffKeys(row: ListingPresenceRow): string[] {
    return (row.diffDetails?.fieldDiffs || []).map((detail) => detail.key);
  }

  function singleJanRows(row: ListingPresenceRow): VariantDiffDetail[] {
    return (row.diffDetails?.variantDiffs || []).filter(
      (detail) => detail.matchType === "singleJan",
    );
  }

  function classifyIssueKeys(
    status: RowStatus,
    drift: DriftStatus,
    diffDetails: DetailedShopifyDiffResult | null,
  ): IssueKey[] {
    if (status !== "both") return ["presence"];
    if (!diffDetails || diffDetails.matches) {
      return drift === "in_sync" || drift === "unknown"
        ? ["synced"]
        : ["timestamp_only"];
    }

    const keys = new Set<IssueKey>();
    const fieldKeys = new Set(diffDetails.fieldDiffs.map((diff) => diff.key));
    const variantDiffs = diffDetails.variantDiffs || [];

    if (
      variantDiffs.some(
        (diff) => diff.matchType !== "singleJan" && isBareShopifySku(diff),
      )
    ) {
      keys.add("bare_sku");
    }
    if (variantDiffs.some((diff) => variantHasField(diff, "inventoryQuantity")))
      keys.add("quantity");
    if (variantDiffs.some((diff) => variantHasField(diff, "image"))) {
      keys.add("variant_image");
    }
    if (diffDetails.galleryImageDiffs.length > 0) keys.add("gallery");
    if (fieldKeys.has("status")) keys.add("status");
    if (fieldKeys.has("productCategory") || fieldKeys.has("productType")) {
      keys.add("category");
    }
    if (variantDiffs.some((diff) => variantHasField(diff, "price"))) {
      keys.add("price");
    }
    if (variantDiffs.some((diff) => variantHasField(diff, "weight"))) {
      keys.add("weight");
    }
    if (
      variantDiffs.some(
        (diff) =>
          diff.matchType === "missingLocal" ||
          diff.matchType === "missingRemote",
      )
    ) {
      keys.add("variant_structure");
    }
    if (
      variantDiffs.some(
        (diff) =>
          diff.matchType !== "singleJan" &&
          (variantHasField(diff, "subtype") ||
            variantHasField(diff, "janCode") ||
            (variantHasField(diff, "sku") && !isBareShopifySku(diff))),
      )
    ) {
      keys.add("variant_identity");
    }
    if (variantDiffs.some((diff) => diff.matchType === "singleJan")) {
      keys.add("single_jan_subtype");
    }
    if (
      ["handle", "title", "bodyHtml", "option1Name"].some((key) =>
        fieldKeys.has(key as any),
      )
    ) {
      keys.add("metadata");
    }

    const sorted = ISSUE_PRIORITY.filter((key) => keys.has(key));
    return sorted.length > 0 ? sorted : ["metadata"];
  }

  function issueChipText(row: ListingPresenceRow, issue: IssueKey): string {
    if (issue === "bare_sku") return `${bareSkuCount(row)} bare SKU`;
    if (issue === "quantity")
      return `${variantDiffCount(row, "inventoryQuantity")} qty`;
    if (issue === "variant_image")
      return `${variantDiffCount(row, "image")} variant image`;
    if (issue === "gallery")
      return `${row.diffDetails?.galleryImageDiffs.length || 0} gallery`;
    if (issue === "price") return `${variantDiffCount(row, "price")} price`;
    if (issue === "weight") return `${variantDiffCount(row, "weight")} weight`;
    if (issue === "variant_structure")
      return `${missingVariantCount(row)} variant count`;
    if (issue === "single_jan_subtype")
      return `${singleJanRows(row).length} single JAN`;
    if (issue === "status") return "status";
    if (issue === "category") return "category";
    if (issue === "variant_identity") return "variant identity";
    if (issue === "metadata")
      return fieldDiffKeys(row).join(", ") || "metadata";
    return ISSUE_LABELS[issue].toLowerCase();
  }

  function issueSummary(row: ListingPresenceRow): string {
    if (row.status === "admin_only") return "Sync would create on Shopify";
    if (row.status === "shopify_only") return "Only in Shopify";
    return row.issueKeys.map((issue) => issueChipText(row, issue)).join(", ");
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
        let diffDetails: DetailedShopifyDiffResult | null = null;
        if (status === "both" && listing && remoteListing) {
          const projection = buildAdminShopifyListingProjectionFromState(
            state,
            handle,
          );
          if (projection) {
            const result = diffComparableShopifyListingsDetailed(
              buildComparableAdminShopifySyncProjection(projection),
              buildComparableRemoteListing(remoteListing),
            );
            deepDiff = !result.matches;
            mismatchKeys = result.mismatchKeys;
            diffDetails = result;
          }
        }

        const issueKeys = classifyIssueKeys(status, drift, diffDetails);

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
          diffDetails,
          issueKeys,
          primaryIssue: issueKeys[0],
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
    if (row.status === "admin_only") return "would_create";
    if (row.status === "shopify_only") return "shopify_only";
    if (row.deepDiff) return "would_update";
    return "no_edit";
  }

  function formatTableStatus(status: TableStatus): string {
    if (status === "would_create") return "would create";
    if (status === "would_update") return "would update";
    if (status === "no_edit") return "no edit";
    return "only in Shopify";
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

  function buildListingSyncRequest(
    state: any,
    handle: string,
    uid: string,
  ): Record<string, any> | null {
    const projection = buildAdminShopifyListingProjectionFromState(
      state,
      handle,
    );
    if (!projection) return null;

    const requestId = `listing-sync-${Date.now()}-${uid}`;
    const nowMs = Date.now();
    return buildShopifySyncRequestEvent({
      projection,
      requestId,
      uid,
      source: "shopify-listings-page",
      nowMs,
      serverTimestamp: serverTimestamp(),
    });
  }

  function syncableRows(
    sectionRows: ListingPresenceRow[],
  ): ListingPresenceRow[] {
    return sectionRows.filter((row) => row.inAdmin);
  }

  async function syncListingsForSection(
    issue: IssueKey,
    sectionRows: ListingPresenceRow[],
  ) {
    if (!$user?.uid || bulkSyncIssue) return;

    const rowsToSync = syncableRows(sectionRows);
    if (rowsToSync.length === 0) {
      bulkSyncMessage = `No admin listings to sync in ${ISSUE_LABELS[issue]}.`;
      return;
    }

    bulkSyncIssue = issue;
    bulkSyncMessage = "";

    let queued = 0;
    let skipped = 0;
    try {
      const state = store.getState();
      for (const row of rowsToSync) {
        const request = buildListingSyncRequest(state, row.handle, $user.uid);
        if (!request) {
          skipped += 1;
          continue;
        }
        await addDoc(
          collection(firestore, SHOPIFY_REQUEST_COLLECTION),
          request,
        );
        queued += 1;
      }
      bulkSyncMessage = `Queued ${queued} Shopify sync request${queued === 1 ? "" : "s"} for ${ISSUE_LABELS[issue]}${skipped ? `; skipped ${skipped}` : ""}.`;
    } catch (e: any) {
      bulkSyncMessage =
        e?.message ||
        `Failed to queue sync requests for ${ISSUE_LABELS[issue]}.`;
    } finally {
      bulkSyncIssue = null;
    }
  }

  $: currentState = $store;
  $: catalogState = currentState.shopifyCatalog || {};
  $: adminHandles = getAdminHandles(currentState);
  $: remoteHandles = getRemoteHandles(currentState);
  $: rows = buildRows(currentState, adminHandles, remoteHandles);
  $: logDriftDecisions(rows);
  $: issueCounts = ISSUE_PRIORITY.reduce(
    (acc, issue) => {
      acc[issue] = rows.filter((row) => row.issueKeys.includes(issue)).length;
      return acc;
    },
    {} as Record<IssueKey, number>,
  );
  $: actionableRows = rows.filter(
    (row) =>
      row.primaryIssue !== "synced" && row.primaryIssue !== "timestamp_only",
  );
  $: summary = {
    adminOnly: rows.filter((r) => r.status === "admin_only").length,
    shopifyOnly: rows.filter((r) => r.status === "shopify_only").length,
    deepDiff: rows.filter((r) => r.deepDiff).length,
    synced: rows.filter(
      (r) =>
        r.status === "both" &&
        !r.deepDiff &&
        (r.drift === "in_sync" || r.drift === "unknown"),
    ).length,
    actionable: actionableRows.length,
    timestampOnly: rows.filter((r) => r.primaryIssue === "timestamp_only")
      .length,
  };
  $: sectionIssueKeys = ISSUE_PRIORITY.filter((issue) => {
    if (activeFilter === "ALL") return (issueCounts[issue] || 0) > 0;
    if (activeFilter === "ACTIONABLE") {
      return (
        issue !== "synced" &&
        issue !== "timestamp_only" &&
        (issueCounts[issue] || 0) > 0
      );
    }
    return issue === activeFilter && (issueCounts[issue] || 0) > 0;
  });
  $: issueSections = sectionIssueKeys.map((issue) => ({
    issue,
    rows: rows.filter((row) =>
      activeFilter === issue
        ? row.issueKeys.includes(issue)
        : row.primaryIssue === issue,
    ),
  }));
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
        Preview what an admin-to-Shopify listing sync would create or update.
        Full refresh is still needed to reconcile deletions.
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
        class:active={activeFilter === "ACTIONABLE"}
        on:click={() => (activeFilter = "ACTIONABLE")}
      >
        <span class="label">Would Edit</span>
        <span class="value">{summary.actionable}</span>
      </button>
      <button
        class="summary-card issue"
        class:active={activeFilter === "bare_sku"}
        on:click={() => (activeFilter = "bare_sku")}
      >
        <span class="label">Bare SKU</span>
        <span class="value">{issueCounts.bare_sku || 0}</span>
      </button>
      <button
        class="summary-card issue"
        class:active={activeFilter === "quantity"}
        on:click={() => (activeFilter = "quantity")}
      >
        <span class="label">Quantity</span>
        <span class="value">{issueCounts.quantity || 0}</span>
      </button>
      <button
        class="summary-card issue"
        class:active={activeFilter === "variant_image"}
        on:click={() => (activeFilter = "variant_image")}
      >
        <span class="label">Variant Image</span>
        <span class="value">{issueCounts.variant_image || 0}</span>
      </button>
      <button
        class="summary-card issue"
        class:active={activeFilter === "gallery"}
        on:click={() => (activeFilter = "gallery")}
      >
        <span class="label">Product Images</span>
        <span class="value">{issueCounts.gallery || 0}</span>
      </button>
      <button
        class="summary-card issue"
        class:active={activeFilter === "status"}
        on:click={() => (activeFilter = "status")}
      >
        <span class="label">Status</span>
        <span class="value">{issueCounts.status || 0}</span>
      </button>
      <button
        class="summary-card admin"
        class:active={activeFilter === "presence"}
        on:click={() => (activeFilter = "presence")}
      >
        <span class="label">Presence</span>
        <span class="value">{issueCounts.presence || 0}</span>
      </button>
      <button
        class="summary-card low-priority"
        class:active={activeFilter === "single_jan_subtype"}
        on:click={() => (activeFilter = "single_jan_subtype")}
      >
        <span class="label">Single JAN</span>
        <span class="value">{issueCounts.single_jan_subtype || 0}</span>
      </button>
      <button
        class="summary-card synced"
        class:active={activeFilter === "timestamp_only"}
        on:click={() => (activeFilter = "timestamp_only")}
      >
        <span class="label">Timestamp Only</span>
        <span class="value">{summary.timestampOnly}</span>
      </button>
      <button
        class="summary-card synced"
        class:active={activeFilter === "synced"}
        on:click={() => (activeFilter = "synced")}
      >
        <span class="label">No Edit</span>
        <span class="value">{summary.synced}</span>
      </button>
      <button
        class="summary-card all"
        class:active={activeFilter === "ALL"}
        on:click={() => (activeFilter = "ALL")}
      >
        <span class="label">All Rows</span>
        <span class="value">{rows.length}</span>
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
    {#if bulkSyncMessage}
      <div class="bulk-sync-message">{bulkSyncMessage}</div>
    {/if}

    {#if issueSections.length === 0}
      <div class="empty-state">No rows for current filter.</div>
    {:else}
      <div class="issue-sections">
        {#each issueSections as section}
          <details class="issue-section">
            <summary>
              <span>
                <strong>{ISSUE_LABELS[section.issue]}</strong>
                <span class="section-description">
                  {ISSUE_DESCRIPTIONS[section.issue]}
                </span>
              </span>
              <span class="section-count">{section.rows.length}</span>
            </summary>
            <div class="section-toolbar">
              <button
                class="btn-sync-section"
                type="button"
                on:click={() =>
                  syncListingsForSection(section.issue, section.rows)}
                disabled={!$user ||
                  bulkSyncIssue !== null ||
                  syncableRows(section.rows).length === 0}
              >
                {#if bulkSyncIssue === section.issue}
                  Queueing…
                {:else}
                  Sync all ({syncableRows(section.rows).length})
                {/if}
              </button>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Handle</th>
                    <th>Issue</th>
                    <th>Status</th>
                    <th>Admin Updated</th>
                    <th>Shopify Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {#each section.rows as row}
                    <tr>
                      <td class="mono handle-cell">
                        <a
                          class="handle-link"
                          href={`/shopify-listings/diff?handle=${encodeURIComponent(row.handle)}`}
                        >
                          {row.handle}
                        </a>
                        <a
                          class="secondary-link"
                          href={`/listing-detail?handle=${encodeURIComponent(row.handle)}`}
                        >
                          local
                        </a>
                      </td>
                      <td>
                        <div class="issue-summary">{issueSummary(row)}</div>
                        <div class="issue-chips">
                          {#each row.issueKeys as issue}
                            <button
                              class="issue-chip {issue}"
                              type="button"
                              on:click={() => (activeFilter = issue)}
                              title={ISSUE_DESCRIPTIONS[issue]}
                            >
                              {issueChipText(row, issue)}
                            </button>
                          {/each}
                        </div>
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
                    <tr class="issue-detail-row">
                      <td colspan="5">
                        <ShopifyListingIssueDetail
                          issue={section.issue}
                          {row}
                        />
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        {/each}
      </div>
    {/if}
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

  .summary-card.issue {
    background: #fef3c7;
    color: #92400e;
  }

  .summary-card.admin-ahead {
    background: #dcfce7;
    color: #166534;
  }

  .summary-card.shopify-ahead {
    background: #ecfdf5;
    color: #065f46;
  }

  .summary-card.low-priority {
    background: #eef2ff;
    color: #3730a3;
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

  .bulk-sync-message {
    margin-bottom: 0.75rem;
    background: #ecfdf5;
    color: #065f46;
    border: 1px solid #a7f3d0;
    border-radius: 8px;
    padding: 0.65rem 0.75rem;
    font-size: 0.9rem;
    font-weight: 650;
  }

  .table-wrap {
    overflow: auto;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: white;
  }

  .issue-sections {
    display: grid;
    gap: 1rem;
  }

  .issue-section {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    overflow: hidden;
  }

  .issue-section > summary {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 0.9rem;
    background: #f9fafb;
    cursor: pointer;
  }

  .section-description {
    display: block;
    margin-top: 0.15rem;
    color: #6b7280;
    font-size: 0.82rem;
    font-weight: 500;
  }

  .section-count {
    min-width: 2rem;
    border-radius: 999px;
    background: #111827;
    color: white;
    text-align: center;
    padding: 0.2rem 0.55rem;
    font-size: 0.8rem;
    font-weight: 800;
  }

  .issue-section .table-wrap {
    border: 0;
    border-top: 1px solid #e5e7eb;
    border-radius: 0;
  }

  .section-toolbar {
    display: flex;
    justify-content: flex-end;
    padding: 0.65rem 0.9rem;
    border-top: 1px solid #e5e7eb;
    background: #fff;
  }

  .btn-sync-section {
    border: 0;
    border-radius: 8px;
    background: #0b57d0;
    color: white;
    cursor: pointer;
    font-size: 0.86rem;
    font-weight: 750;
    padding: 0.45rem 0.75rem;
  }

  .btn-sync-section:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 920px;
  }

  th,
  td {
    text-align: left;
    border-bottom: 1px solid #f3f4f6;
    padding: 0.6rem 0.75rem;
    font-size: 0.92rem;
    vertical-align: top;
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

  .handle-cell {
    max-width: 360px;
  }

  .secondary-link {
    display: inline-block;
    margin-left: 0.4rem;
    color: #6b7280;
    font-size: 0.78rem;
    text-decoration: none;
  }

  .secondary-link:hover {
    text-decoration: underline;
  }

  .issue-summary {
    color: #111827;
    font-weight: 650;
    margin-bottom: 0.25rem;
  }

  .issue-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .issue-detail-row td {
    padding: 0;
    border-bottom: 1px solid #e5e7eb;
  }

  .issue-detail-row + tr td {
    border-top: 0;
  }

  .issue-chip {
    border: 0;
    border-radius: 999px;
    background: #f3f4f6;
    color: #374151;
    padding: 0.18rem 0.5rem;
    font-size: 0.75rem;
    font-weight: 800;
    cursor: pointer;
  }

  .issue-chip:hover {
    filter: brightness(0.96);
  }

  .issue-chip.bare_sku,
  .issue-chip.quantity,
  .issue-chip.variant_image,
  .issue-chip.gallery {
    background: #fef3c7;
    color: #92400e;
  }

  .issue-chip.presence,
  .issue-chip.status {
    background: #fee2e2;
    color: #991b1b;
  }

  .issue-chip.price,
  .issue-chip.weight,
  .issue-chip.category {
    background: #e0f2fe;
    color: #075985;
  }

  .empty-state {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: white;
    color: #6b7280;
    padding: 1rem;
    text-align: center;
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

  .badge.would_create {
    background: #fee2e2;
    color: #991b1b;
  }

  .badge.shopify_only {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .badge.would_update {
    background: #fef3c7;
    color: #92400e;
  }

  .badge.no_edit {
    background: #dcfce7;
    color: #166534;
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
