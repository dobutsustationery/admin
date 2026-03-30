<script lang="ts">
  import { page } from "$app/stores";
  import JsonTree from "$lib/components/JsonTree.svelte";
  import { formatLogTimestamp } from "$lib/format-log-timestamp";
  import {
    buildComparableLocalListing,
    buildComparableRemoteListing,
    diffComparableShopifyListings,
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
      ? diffComparableShopifyListings(localComparable, remoteComparable)
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
        <div class="diff-list">
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
      </div>
    {/if}

    <div class="two-up">
      <div class="section">
        <h2>Normalized Local</h2>
        <div class="tree-wrap">
          <JsonTree value={localComparable} label="local" expanded={true} />
        </div>
      </div>
      <div class="section">
        <h2>Normalized Shopify</h2>
        <div class="tree-wrap">
          <JsonTree value={remoteComparable} label="shopify" expanded={true} />
        </div>
      </div>
    </div>

    <div class="two-up">
      <div class="section">
        <h2>Raw Local Listing</h2>
        <div class="tree-wrap">
          <JsonTree
            value={localListingRaw}
            label="localListing"
            expanded={true}
          />
        </div>
      </div>
      <div class="section">
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

  .diff-card {
    overflow: hidden;
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

  @media (max-width: 900px) {
    .diff-columns,
    .two-up,
    .header {
      grid-template-columns: 1fr;
      display: grid;
    }
  }
</style>
