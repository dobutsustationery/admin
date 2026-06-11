<script lang="ts">
  import { page } from "$app/stores";
  import JsonTree from "$lib/components/JsonTree.svelte";
  import ItemHistoryValue from "$lib/components/ItemHistoryValue.svelte";
  import { formatLogTimestamp } from "$lib/format-log-timestamp";
  import {
    buildComparableLocalListing,
    buildComparableRemoteListing,
    diffComparableShopifyListingsDetailed,
    type GalleryImageDiffDetail,
    type VariantDiffDetail,
    type VariantDiffField,
  } from "$lib/shopify-deep-diff";
  import { store } from "$lib/store";

  type DiffKey =
    | "handle"
    | "title"
    | "bodyHtml"
    | "vendor"
    | "productType"
    | "productCategory"
    | "status"
    | "option1Name"
    | "tags"
    | "galleryImages"
    | "variants";

  const LABELS: Record<DiffKey, string> = {
    handle: "Handle",
    title: "Title",
    bodyHtml: "Body HTML",
    vendor: "Vendor",
    productType: "Product Type",
    productCategory: "Product Category",
    status: "Status",
    option1Name: "Option 1 Name",
    tags: "Tags",
    galleryImages: "Gallery Images",
    variants: "Variants",
  };

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

  function getFieldValue(record: any, key: DiffKey) {
    return record?.[key];
  }

  function variantValue(
    detail: VariantDiffDetail,
    side: "local" | "remote",
    field: VariantDiffField,
  ) {
    const variant = detail?.[side];
    if (!variant) return "-";
    return variant[field] === "" ? "(blank)" : variant[field];
  }

  function variantLabel(detail: VariantDiffDetail): string {
    const local = detail.local;
    const remote = detail.remote;
    return (
      local?.sku ||
      remote?.sku ||
      local?.subtype ||
      remote?.subtype ||
      "(variant)"
    );
  }

  function imageValue(
    detail: GalleryImageDiffDetail,
    side: "local" | "remote",
    field: "url" | "altText",
  ) {
    const image = detail?.[side];
    if (!image) return "-";
    return image[field] === "" ? "(blank)" : image[field];
  }

  function fieldLabel(field: string): string {
    const labels: Record<string, string> = {
      sku: "SKU",
      subtype: "Subtype",
      price: "Price",
      janCode: "JAN",
      weight: "Weight",
      inventoryQuantity: "On Hand",
      image: "Image",
      url: "URL",
      altText: "Alt Text",
    };
    return labels[field] || field;
  }

  $: handle = $page.url.searchParams.get("handle") || "";
  $: currentState = $store;
  $: localListingRaw = handle
    ? currentState.listings?.handleToListing?.[handle] || null
    : null;
  $: remoteListingRaw = handle
    ? currentState.shopifyCatalog?.handleToListing?.[handle] || null
    : null;
  $: associatedItems = handle ? getItemsForHandle(currentState, handle) : [];
  $: localComparable =
    handle && localListingRaw
      ? buildComparableLocalListing({
          handle,
          listing: localListingRaw,
          items: associatedItems,
        })
      : null;
  $: remoteComparable =
    handle && remoteListingRaw
      ? buildComparableRemoteListing(remoteListingRaw)
      : null;
  $: diffResult =
    localComparable && remoteComparable
      ? diffComparableShopifyListingsDetailed(localComparable, remoteComparable)
      : null;
  $: mismatchKeys = (diffResult?.mismatchKeys || []) as DiffKey[];
</script>

<svelte:head>
  <title>Shopify Listing Diff</title>
</svelte:head>

<div class="page">
  <div class="header">
    <div>
      <a class="back-link" href="/shopify-listings"
        >← Back to Shopify Listings</a
      >
      <h1>Shopify Diff</h1>
      <p class="subtext">{handle || "No handle selected"}</p>
    </div>
    {#if remoteListingRaw}
      <div class="meta-chip">
        Shopify updated:
        {remoteListingRaw.updatedAtMs > 0
          ? formatLogTimestamp(remoteListingRaw.updatedAtMs)
          : "-"}
      </div>
    {/if}
  </div>

  {#if !handle}
    <div class="empty-state">Missing `handle` query parameter.</div>
  {:else if !localListingRaw && !remoteListingRaw}
    <div class="empty-state">
      No local listing or Shopify shadow listing was found for this handle.
    </div>
  {:else}
    <div class="summary-grid">
      <div class="summary-card">
        <span class="summary-label">Local listing</span>
        <span class="summary-value"
          >{localListingRaw ? "present" : "missing"}</span
        >
      </div>
      <div class="summary-card">
        <span class="summary-label">Shopify shadow</span>
        <span class="summary-value"
          >{remoteListingRaw ? "present" : "missing"}</span
        >
      </div>
      <div class="summary-card">
        <span class="summary-label">Local variants</span>
        <span class="summary-value">{associatedItems.length}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Mismatch fields</span>
        <span class="summary-value">{mismatchKeys.length}</span>
      </div>
    </div>

    {#if diffResult && mismatchKeys.length === 0}
      <div class="match-banner">Normalized local and Shopify data match.</div>
    {/if}

    {#if diffResult && mismatchKeys.length > 0}
      <div class="section">
        <h2>Mismatches</h2>
        <div class="mismatch-chips">
          {#each mismatchKeys as key}
            <span class="mismatch-chip">{LABELS[key]}</span>
          {/each}
        </div>

        {#if diffResult.fieldDiffs.length > 0}
          <div class="diff-card">
            <div class="diff-card-header">
              <span class="diff-key">Listing Fields</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Local</th>
                    <th>Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {#each diffResult.fieldDiffs as diff}
                    <tr>
                      <td>{LABELS[diff.key]}</td>
                      <td>{String(diff.local || "(blank)")}</td>
                      <td>{String(diff.remote || "(blank)")}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}

        {#if diffResult.variantDiffs.length > 0}
          <div class="diff-card">
            <div class="diff-card-header">
              <span class="diff-key">Variants</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Variant</th>
                    <th>Matched By</th>
                    <th>Field</th>
                    <th>Local</th>
                    <th>Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {#each diffResult.variantDiffs as diff}
                    {#if diff.fields.length === 0}
                      <tr>
                        <td><ItemHistoryValue value={variantLabel(diff)} /></td>
                        <td>{diff.matchType}</td>
                        <td>presence</td>
                        <td>{diff.local ? "present" : "-"}</td>
                        <td>{diff.remote ? "present" : "-"}</td>
                      </tr>
                    {:else}
                      {#each diff.fields as field}
                        <tr>
                          <td
                            ><ItemHistoryValue value={variantLabel(diff)} /></td
                          >
                          <td>{diff.matchType}</td>
                          <td>{fieldLabel(field)}</td>
                          <td
                            ><ItemHistoryValue
                              value={variantValue(diff, "local", field)}
                            /></td
                          >
                          <td
                            ><ItemHistoryValue
                              value={variantValue(diff, "remote", field)}
                            /></td
                          >
                        </tr>
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}

        {#if diffResult.galleryImageDiffs.length > 0}
          <div class="diff-card">
            <div class="diff-card-header">
              <span class="diff-key">Gallery Images</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Image</th>
                    <th>Field</th>
                    <th>Local</th>
                    <th>Shopify</th>
                  </tr>
                </thead>
                <tbody>
                  {#each diffResult.galleryImageDiffs as diff, index}
                    {#if diff.fields.length === 0}
                      <tr>
                        <td>#{index + 1}</td>
                        <td>presence</td>
                        <td>{diff.local ? "present" : "-"}</td>
                        <td>{diff.remote ? "present" : "-"}</td>
                      </tr>
                    {:else}
                      {#each diff.fields as field}
                        <tr>
                          <td>#{index + 1}</td>
                          <td>{fieldLabel(field)}</td>
                          <td>{imageValue(diff, "local", field)}</td>
                          <td>{imageValue(diff, "remote", field)}</td>
                        </tr>
                      {/each}
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if diffResult && mismatchKeys.length > 0}
      <details class="section">
        <summary>Raw normalized field diffs</summary>
        <div class="diff-list raw-diff-list">
          {#each mismatchKeys as key}
            <div class="diff-card">
              <div class="diff-card-header">
                <span class="diff-key">{LABELS[key]}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-column">
                  <div class="column-label">Local</div>
                  <div class="tree-wrap">
                    <JsonTree
                      value={getFieldValue(localComparable, key)}
                      label={key}
                      expanded={true}
                    />
                  </div>
                </div>
                <div class="diff-column">
                  <div class="column-label">Shopify</div>
                  <div class="tree-wrap">
                    <JsonTree
                      value={getFieldValue(remoteComparable, key)}
                      label={key}
                      expanded={true}
                    />
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>
      </details>
    {/if}

    <details class="section raw-full">
      <summary>Raw normalized listings</summary>
      <div class="two-up">
        <div>
          <h2>Normalized Local</h2>
          <div class="tree-wrap">
            <JsonTree value={localComparable} label="local" expanded={true} />
          </div>
        </div>
        <div>
          <h2>Normalized Shopify</h2>
          <div class="tree-wrap">
            <JsonTree
              value={remoteComparable}
              label="shopify"
              expanded={true}
            />
          </div>
        </div>
      </div>
    </details>

    <details class="section raw-full">
      <summary>Raw source records</summary>
      <div class="two-up">
        <div>
          <h2>Raw Local Listing</h2>
          <div class="tree-wrap">
            <JsonTree
              value={localListingRaw}
              label="localListing"
              expanded={true}
            />
          </div>
        </div>
        <div>
          <h2>Raw Shopify Shadow</h2>
          <div class="tree-wrap">
            <JsonTree
              value={remoteListingRaw}
              label="shopifyShadow"
              expanded={true}
            />
          </div>
        </div>
      </div>
    </details>
  {/if}
</div>

<style>
  .page {
    max-width: 1280px;
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

  .back-link {
    display: inline-block;
    margin-bottom: 0.5rem;
    color: #0b57d0;
    text-decoration: none;
    font-weight: 600;
  }

  .back-link:hover {
    text-decoration: underline;
  }

  h1 {
    margin: 0;
    font-size: 1.6rem;
  }

  h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
  }

  .subtext {
    margin: 0.25rem 0 0;
    color: #4b5563;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }

  .meta-chip {
    background: #f3f4f6;
    color: #374151;
    border-radius: 999px;
    padding: 0.45rem 0.75rem;
    font-size: 0.85rem;
    font-weight: 600;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .summary-card,
  .section,
  .diff-card,
  .empty-state,
  .match-banner {
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    background: #fff;
  }

  .summary-card {
    padding: 0.75rem 0.9rem;
  }

  .summary-label {
    display: block;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #6b7280;
    font-weight: 700;
  }

  .summary-value {
    display: block;
    margin-top: 0.2rem;
    font-size: 1.1rem;
    font-weight: 800;
    color: #111827;
  }

  .empty-state,
  .match-banner {
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .match-banner {
    background: #ecfdf5;
    border-color: #a7f3d0;
    color: #065f46;
  }

  .section {
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .diff-list {
    display: grid;
    gap: 0.75rem;
  }

  .raw-diff-list {
    margin-top: 0.75rem;
  }

  .diff-card {
    overflow: hidden;
    margin-top: 0.75rem;
  }

  .diff-card-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #f3f4f6;
    background: #fff7ed;
  }

  .diff-key {
    font-weight: 800;
    color: #9a3412;
  }

  .mismatch-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.75rem;
  }

  .mismatch-chip {
    border-radius: 999px;
    background: #fef3c7;
    color: #92400e;
    padding: 0.2rem 0.55rem;
    font-size: 0.78rem;
    font-weight: 800;
  }

  .table-wrap {
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 720px;
  }

  th,
  td {
    text-align: left;
    border-bottom: 1px solid #f3f4f6;
    padding: 0.5rem 0.65rem;
    vertical-align: top;
    font-size: 0.9rem;
  }

  th {
    background: #f9fafb;
    color: #374151;
  }

  td {
    overflow-wrap: anywhere;
  }

  .diff-columns,
  .two-up {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }

  .diff-columns {
    padding: 1rem;
  }

  .diff-column {
    min-width: 0;
  }

  .column-label {
    font-size: 0.8rem;
    font-weight: 700;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.5rem;
  }

  .tree-wrap {
    overflow: auto;
    max-height: 480px;
    background: #fafafa;
    border: 1px solid #f3f4f6;
    border-radius: 8px;
    padding: 0.75rem;
  }

  details.section > summary {
    cursor: pointer;
    font-weight: 800;
    color: #111827;
  }

  .raw-full .two-up {
    margin-top: 0.75rem;
  }

  @media (max-width: 900px) {
    .diff-columns,
    .two-up,
    .header {
      grid-template-columns: 1fr;
      display: grid;
    }
  }
</style>
