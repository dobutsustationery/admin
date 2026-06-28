<script lang="ts">
  import { addDoc, collection, serverTimestamp } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import type {
    AmazonCatalogState,
    AmazonRawApiResponseRecord,
  } from "$lib/amazon-catalog-slice";

  const AMAZON_CATALOG_PROBE_REQUEST_COLLECTION =
    "request_amazon_catalog_probe";

  type LocalMatch = {
    itemKey: string;
    handle: string;
    title: string;
    description: string;
    qty: number;
    shipped: number;
    onHand: number;
  };

  type AmazonRow = {
    jan: string;
    localMatches: LocalMatch[];
    catalogResponse: AmazonRawApiResponseRecord | null;
    sellerResponse: AmazonRawApiResponseRecord | null;
    asin: string;
    catalogTitle: string;
    productType: string;
    sellerSku: string;
    sellerStatus: string;
    sellerIssues: number;
    offerPrice: string;
    fulfillmentQty: string;
    sellerUpdatedAt: string;
  };

  let janInput = "4542804131499";
  let skuInput = "";
  let includeSellerListings = true;
  let isRequesting = false;
  let requestMessage = "";
  let requestError = "";
  let lastQueuedRequestId = "";

  function firstArray<T = any>(value: unknown): T[] {
    return Array.isArray(value) ? (value as T[]) : [];
  }

  function getRawResponse(
    amazonCatalog: AmazonCatalogState | undefined,
    id: string,
  ): AmazonRawApiResponseRecord | null {
    if (!amazonCatalog || !id) return null;
    return amazonCatalog.rawResponsesById?.[id] || null;
  }

  function getCatalogItem(response: AmazonRawApiResponseRecord | null): any {
    return firstArray((response?.raw as any)?.items)[0] || null;
  }

  function getSellerItem(response: AmazonRawApiResponseRecord | null): any {
    return firstArray((response?.raw as any)?.items)[0] || null;
  }

  function getCatalogSummary(item: any): any {
    return firstArray(item?.summaries)[0] || {};
  }

  function getSellerSummary(item: any): any {
    return firstArray(item?.summaries)[0] || {};
  }

  function getProductType(catalogItem: any, sellerItem: any): string {
    const sellerType =
      firstArray<any>(sellerItem?.productTypes)[0]?.productType ||
      getSellerSummary(sellerItem)?.productType;
    const catalogType = firstArray<any>(catalogItem?.productTypes)[0]
      ?.productType;
    return String(sellerType || catalogType || "");
  }

  function formatTimestamp(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    return new Date(ms).toLocaleString();
  }

  function formatSellerUpdatedAt(value: unknown): string {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return raw;
    return new Date(parsed).toLocaleString();
  }

  function splitInput(value: string): string[] {
    return String(value || "")
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry, index, all) => all.indexOf(entry) === index);
  }

  function getLocalJans(state: any): string[] {
    const idToItem = state?.inventory?.idToItem || {};
    return Object.values(idToItem)
      .map((item: any) => String(item?.janCode || "").trim())
      .filter(Boolean)
      .filter((jan, index, all) => all.indexOf(jan) === index)
      .sort((a, b) => a.localeCompare(b));
  }

  function useVisibleJans() {
    janInput = rows.map((row) => row.jan).join("\n");
    skuInput = "";
  }

  function useAllLocalJans() {
    janInput = localJans.join("\n");
    skuInput = "";
  }

  async function requestAmazonProbe() {
    requestError = "";
    requestMessage = "";
    lastQueuedRequestId = "";

    const jans = splitInput(janInput);
    const skus = splitInput(skuInput);
    if (!$user?.uid) {
      requestError = "You must be signed in to request an Amazon probe.";
      return;
    }
    if (jans.length === 0 && skus.length === 0) {
      requestError = "Enter at least one JAN or SKU.";
      return;
    }

    isRequesting = true;
    try {
      const docRef = await addDoc(
        collection(firestore, AMAZON_CATALOG_PROBE_REQUEST_COLLECTION),
        {
          eventType: "amazon/catalog_probe_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-listings-page",
          jans,
          skus,
          includeSellerListings,
          identifiersType: "JAN",
          listingIdentifiersType: "JAN",
          createdAtMs: Date.now(),
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      lastQueuedRequestId = docRef.id;
      requestMessage = `Queued Amazon probe for ${jans.length} JAN${jans.length === 1 ? "" : "s"}${skus.length ? ` and ${skus.length} SKU${skus.length === 1 ? "" : "s"}` : ""}.`;
    } catch (error: any) {
      requestError = error?.message || "Failed to queue Amazon probe.";
    } finally {
      isRequesting = false;
    }
  }

  function getLocalMatches(state: any, jan: string): LocalMatch[] {
    const idToItem = state?.inventory?.idToItem || {};
    const idToHandle = state?.listings?.idToHandle || {};
    const handleToListing = state?.listings?.handleToListing || {};

    return Object.entries(idToItem)
      .filter(([_, item]: [string, any]) => String(item?.janCode || "") === jan)
      .map(([itemKey, item]: [string, any]) => {
        const handle = String(idToHandle[itemKey] || "");
        const listing = handle ? handleToListing[handle] : null;
        const qty = Number(item?.qty || 0);
        const shipped = Number(item?.shipped || 0);
        return {
          itemKey,
          handle,
          title: String(listing?.title || ""),
          description: String(item?.description || ""),
          qty,
          shipped,
          onHand: qty - shipped,
        };
      })
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  }

  function buildRows(state: any): AmazonRow[] {
    const amazonCatalog = state?.amazonCatalog as
      | AmazonCatalogState
      | undefined;
    if (!amazonCatalog) return [];

    const jans = Array.from(
      new Set([
        ...Object.keys(amazonCatalog.catalogRawResponseIdByJan || {}),
        ...Object.keys(amazonCatalog.sellerListingsRawResponseIdByJan || {}),
      ]),
    ).sort();

    return jans.map((jan) => {
      const catalogResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.catalogRawResponseIdByJan?.[jan],
      );
      const sellerResponse = getRawResponse(
        amazonCatalog,
        amazonCatalog.sellerListingsRawResponseIdByJan?.[jan],
      );
      const catalogItem = getCatalogItem(catalogResponse);
      const sellerItem = getSellerItem(sellerResponse);
      const catalogSummary = getCatalogSummary(catalogItem);
      const sellerSummary = getSellerSummary(sellerItem);
      const offer = firstArray<any>(sellerItem?.offers)[0];
      const price = offer?.price;
      const availability = firstArray<any>(
        sellerItem?.fulfillmentAvailability,
      )[0];
      const issueCount = firstArray(sellerItem?.issues).length;
      const sellerStatus = firstArray(sellerSummary?.status).join(", ");

      return {
        jan,
        localMatches: getLocalMatches(state, jan),
        catalogResponse,
        sellerResponse,
        asin: String(sellerSummary?.asin || catalogItem?.asin || ""),
        catalogTitle: String(
          sellerSummary?.itemName || catalogSummary?.itemName || "",
        ),
        productType: getProductType(catalogItem, sellerItem),
        sellerSku: String(sellerItem?.sku || ""),
        sellerStatus,
        sellerIssues: issueCount,
        offerPrice:
          price?.amount && (price?.currencyCode || price?.currency)
            ? `${price.currencyCode || price.currency} ${price.amount}`
            : "",
        fulfillmentQty:
          availability?.quantity === undefined
            ? ""
            : String(availability.quantity),
        sellerUpdatedAt: formatSellerUpdatedAt(sellerSummary?.lastUpdatedDate),
      };
    });
  }

  function rowClass(row: AmazonRow): string {
    if (!row.catalogResponse?.ok || !row.sellerResponse?.ok) return "error";
    if (!row.asin || !row.sellerSku) return "missing";
    if (row.sellerIssues > 0) return "issue";
    if (!row.sellerStatus.includes("BUYABLE")) return "issue";
    return "ok";
  }

  $: state = $store;
  $: amazonCatalog = state.amazonCatalog as AmazonCatalogState;
  $: rows = buildRows(state);
  $: localJans = getLocalJans(state);
  $: lastCompleted = formatTimestamp(
    amazonCatalog?.lastProbeCompletedAtMs || 0,
  );
</script>

<svelte:head>
  <title>Amazon Listings</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <h1>Amazon Listings</h1>
      <p>
        Read-only v0 view of replayed Amazon SP-API catalog and seller-listing
        observations.
      </p>
    </div>
    <div class="meta">
      <div><span>Marketplace</span>{amazonCatalog?.marketplaceId || "-"}</div>
      <div>
        <span>Raw responses</span>{amazonCatalog?.rawResponseIds?.length || 0}
      </div>
      <div><span>Last probe</span>{lastCompleted || "-"}</div>
    </div>
  </header>

  <section class="command-band">
    <div>
      <h2>Refresh Data</h2>
      <p>
        Queue a read-only Amazon SP-API probe. The backend preserves the raw API
        responses in replayable broadcast actions.
      </p>
    </div>
    <div class="probe-form">
      <label>
        <span>JANs</span>
        <textarea bind:value={janInput} rows="4" placeholder="4542804131499" />
      </label>
      <label>
        <span>Seller SKUs</span>
        <textarea bind:value={skuInput} rows="2" placeholder="Optional" />
      </label>
      <label class="check-row">
        <input type="checkbox" bind:checked={includeSellerListings} />
        <span>Include seller listing lookup</span>
      </label>
      <div class="actions">
        <button
          type="button"
          on:click={requestAmazonProbe}
          disabled={isRequesting}
        >
          {isRequesting ? "Queueing..." : "Get Amazon Info"}
        </button>
        <button type="button" class="secondary" on:click={useVisibleJans}>
          Use shown JANs
        </button>
        <button
          type="button"
          class="secondary"
          on:click={useAllLocalJans}
          title={`${localJans.length} local JANs`}
        >
          Use all local JANs
        </button>
      </div>
      {#if requestMessage}
        <div class="request-message">
          {requestMessage}
          {#if lastQueuedRequestId}
            <span>{lastQueuedRequestId}</span>
          {/if}
        </div>
      {/if}
      {#if requestError}
        <div class="request-error">{requestError}</div>
      {/if}
    </div>
  </section>

  {#if amazonCatalog?.lastProbeError}
    <section class="error-banner">
      <strong>Last probe failed:</strong>
      {amazonCatalog.lastProbeError}
    </section>
  {/if}

  {#if rows.length === 0}
    <section class="empty">No replayed Amazon observations yet.</section>
  {:else}
    <section class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>JAN</th>
            <th>Local</th>
            <th>ASIN</th>
            <th>Amazon Title</th>
            <th>Product Type</th>
            <th>Seller SKU</th>
            <th>Status</th>
            <th>Issues</th>
            <th>Offer</th>
            <th>Amazon Qty</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.jan)}
            <tr class={rowClass(row)}>
              <td>
                <a href={`/itemhistory?itemKey=${encodeURIComponent(row.jan)}`}>
                  {row.jan}
                </a>
              </td>
              <td>
                {#if row.localMatches.length === 0}
                  <span class="muted">No local item</span>
                {:else}
                  {#each row.localMatches as match (match.itemKey)}
                    <div class="local-match">
                      <a
                        href={`/itemhistory?itemKey=${encodeURIComponent(match.itemKey)}`}
                      >
                        {match.itemKey}
                      </a>
                      {#if match.handle}
                        <a
                          class="handle"
                          href={`/listing-detail?handle=${encodeURIComponent(match.handle)}`}
                        >
                          {match.handle}
                        </a>
                      {/if}
                      <span class="muted">
                        Stock {match.onHand} ({match.qty} - {match.shipped})
                      </span>
                    </div>
                  {/each}
                {/if}
              </td>
              <td>{row.asin || "-"}</td>
              <td>{row.catalogTitle || "-"}</td>
              <td>{row.productType || "-"}</td>
              <td>{row.sellerSku || "-"}</td>
              <td>{row.sellerStatus || "-"}</td>
              <td>{row.sellerIssues}</td>
              <td>{row.offerPrice || "-"}</td>
              <td>{row.fulfillmentQty || "-"}</td>
              <td>{row.sellerUpdatedAt || "-"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</main>

<style>
  .page {
    padding: 24px;
    color: #1f2933;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 20px;
  }

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    font-size: 28px;
    line-height: 1.2;
  }

  h2 {
    font-size: 16px;
    margin-bottom: 6px;
  }

  p {
    margin-top: 6px;
    color: #52616f;
  }

  .meta {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 1fr));
    gap: 12px;
    min-width: 420px;
    font-weight: 700;
  }

  .meta div {
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    padding: 10px 12px;
    background: #f8fafc;
  }

  .meta span {
    display: block;
    color: #627d98;
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 4px;
  }

  .command-band {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 16px;
    background: #f0f4f8;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
    margin-bottom: 18px;
  }

  .probe-form {
    display: grid;
    gap: 10px;
    min-width: min(560px, 100%);
  }

  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
    color: #52616f;
    font-weight: 700;
  }

  textarea {
    width: 100%;
    min-width: 0;
    resize: vertical;
    border: 1px solid #bcccdc;
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
    line-height: 1.35;
    color: #1f2933;
    background: white;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  button {
    border: 1px solid #1d4ed8;
    background: #1d4ed8;
    color: white;
    border-radius: 6px;
    padding: 8px 12px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  button.secondary {
    background: white;
    color: #1d4ed8;
  }

  button:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .request-message,
  .request-error {
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
  }

  .request-message {
    background: #f0fff4;
    border: 1px solid #9ae6b4;
    color: #276749;
  }

  .request-message span {
    display: block;
    color: #52616f;
    font-size: 12px;
    margin-top: 2px;
  }

  .request-error {
    background: #fff5f5;
    border: 1px solid #feb2b2;
    color: #9b2c2c;
  }

  .error-banner,
  .empty {
    padding: 14px 16px;
    border-radius: 6px;
    margin-bottom: 18px;
  }

  .error-banner {
    background: #fff5f5;
    border: 1px solid #feb2b2;
    color: #9b2c2c;
  }

  .empty {
    background: #f8fafc;
    border: 1px solid #d9e2ec;
  }

  .table-wrap {
    overflow-x: auto;
    border: 1px solid #d9e2ec;
    border-radius: 6px;
  }

  table {
    width: 100%;
    min-width: 1300px;
    border-collapse: collapse;
    font-size: 13px;
  }

  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid #edf2f7;
    text-align: left;
    vertical-align: top;
  }

  th {
    background: #f8fafc;
    font-size: 12px;
    color: #52616f;
    position: sticky;
    top: 0;
  }

  tr.ok {
    background: #f7fff7;
  }

  tr.issue {
    background: #fffaf0;
  }

  tr.missing,
  tr.error {
    background: #fff5f5;
  }

  a {
    color: #1d4ed8;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }

  .local-match {
    display: grid;
    gap: 2px;
    margin-bottom: 8px;
  }

  .handle,
  .muted {
    color: #627d98;
  }

  @media (max-width: 900px) {
    .page {
      padding: 16px;
    }

    .page-header,
    .command-band {
      display: block;
    }

    .meta {
      grid-template-columns: 1fr;
      min-width: 0;
      margin-top: 14px;
    }

    .probe-form {
      margin-top: 12px;
    }
  }
</style>
