<script lang="ts">
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import type { Item } from "$lib/inventory";
  import { hide_exception, show_exception } from "$lib/inventory";
  import { canonicalizeInventoryItemKey } from "$lib/sku";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import { formatYen, formatEuro } from "$lib/formatters";

  type IssueCode =
    | "DESCRIPTION"
    | "DESCRIPTION_CAPS"
    | "PRICE"
    | "COST"
    | "WEIGHT"
    | "IMAGE"
    | "HS_CODE"
    | "COUNTRY"
    | "UNLISTED"
    | "CATEGORY";

  interface ReviewIssue {
    code: IssueCode;
    label: string;
  }

  interface ReviewItem {
    key: string;
    item: Item;
    issues: ReviewIssue[];
  }

  interface IssueFilterDef {
    code: IssueCode | "ALL";
    label: string;
    tone: string;
  }

  const ISSUE_FILTERS: IssueFilterDef[] = [
    { code: "ALL", label: "All", tone: "all" },
    { code: "UNLISTED", label: "Unlisted", tone: "unlisted" },
    { code: "IMAGE", label: "Image", tone: "image" },
    { code: "DESCRIPTION", label: "Description", tone: "description" },
    { code: "DESCRIPTION_CAPS", label: "ALL CAPS", tone: "description-caps" },
    { code: "PRICE", label: "Price", tone: "price" },
    { code: "COST", label: "Cost", tone: "cost" },
    { code: "WEIGHT", label: "Weight", tone: "weight" },
    { code: "HS_CODE", label: "HS Code", tone: "hs-code" },
    { code: "COUNTRY", label: "Country", tone: "country" },
    { code: "CATEGORY", label: "Category", tone: "category" },
  ];

  function issue(code: IssueCode, label: string): ReviewIssue {
    return { code, label };
  }

  function getFilterLabel(code: IssueCode | "ALL"): string {
    return ISSUE_FILTERS.find((filter) => filter.code === code)?.label || "All";
  }

  function getFilterCount(code: IssueCode | "ALL"): number {
    return code === "ALL" ? baseVisibleItems.length : (issueCounts[code] ?? 0);
  }

  let skipOutOfStock = true;
  let showHidden = false;
  let activeIssueFilter: IssueCode | "ALL" = "ALL";
  let reviewItems: ReviewItem[] = [];
  let issueCounts: Partial<Record<IssueCode, number>> = {};
  let skippedCount = 0;

  function toggleHide(key: string) {
    if (!$user || !$user.uid) return;
    const isHidden = $store.inventory.hiddenExceptions?.[key];
    if (isHidden) {
      broadcast(
        firestore,
        $user.uid,
        show_exception({ itemKey: canonicalizeInventoryItemKey(key) }),
      );
    } else {
      broadcast(
        firestore,
        $user.uid,
        hide_exception({ itemKey: canonicalizeInventoryItemKey(key) }),
      );
    }
  }

  $: {
    const inv = $store.inventory.idToItem;
    const listings = $store.listings;
    reviewItems = [];
    skippedCount = 0;
    if (inv) {
      for (const key in inv) {
        const item = inv[key];
        const issues: ReviewIssue[] = [];

        if (!item.description) {
          issues.push(issue("DESCRIPTION", "Description"));
        } else if (
          item.description.length > 0 &&
          item.description === item.description.toUpperCase() &&
          /[a-z]/i.test(item.description)
        ) {
          issues.push(issue("DESCRIPTION_CAPS", "Description (ALL CAPS)"));
        }

        if (!item.price) issues.push(issue("PRICE", "Price"));
        if (!item.cost) issues.push(issue("COST", "Cost"));
        if (!item.weight) issues.push(issue("WEIGHT", "Weight"));
        if (!item.image) issues.push(issue("IMAGE", "Image"));
        if (!item.hsCode) issues.push(issue("HS_CODE", "HS Code"));
        if (!item.countryOfOrigin) {
          issues.push(issue("COUNTRY", "Country of Origin"));
        }

        const idToHandle = $store.listings.idToHandle;
        const handleToListing = $store.listings.handleToListing;
        const handle = idToHandle[key];

        const listing = handle ? handleToListing[handle] : undefined;
        if (!listing || !listing.bodyHtml) {
          issues.push(issue("UNLISTED", "Unlisted"));
        }
        if (listing && !listing.productCategory) {
          issues.push(issue("CATEGORY", "Category"));
        }

        const stock = (item.qty || 0) - (item.shipped || 0);

        if (stock <= 0) {
          skippedCount++;
          if (skipOutOfStock) continue;
        }

        if (issues.length > 0) {
          reviewItems.push({ key, item, issues });
        }
      }
      reviewItems.sort((a, b) =>
        b.item.creationDate.localeCompare(a.item.creationDate),
      );
    }
  }

  $: hiddenExceptions = $store.inventory.hiddenExceptions || {};
  $: baseVisibleItems = reviewItems.filter(
    (i) => showHidden || !hiddenExceptions[i.key],
  );
  $: hiddenCount = reviewItems.length - baseVisibleItems.length;
  $: issueCounts = ISSUE_FILTERS.reduce(
    (acc, filter) => {
      if (filter.code === "ALL") return acc;
      acc[filter.code] = baseVisibleItems.filter((item) =>
        item.issues.some((entry) => entry.code === filter.code),
      ).length;
      return acc;
    },
    {} as Partial<Record<IssueCode, number>>,
  );
  $: availableFilters = ISSUE_FILTERS.filter(
    (filter) =>
      filter.code === "ALL" || (issueCounts[filter.code as IssueCode] || 0) > 0,
  );
  $: if (
    activeIssueFilter !== "ALL" &&
    (issueCounts[activeIssueFilter as IssueCode] || 0) === 0
  ) {
    activeIssueFilter = "ALL";
  }
  $: visibleItems =
    activeIssueFilter === "ALL"
      ? baseVisibleItems
      : baseVisibleItems.filter((item) =>
          item.issues.some((entry) => entry.code === activeIssueFilter),
        );
</script>

<div class="container">
  <h1>SKU Review</h1>
  <div class="header-controls">
    <h2 class="summary">
      {visibleItems.length}
      {#if activeIssueFilter === "ALL"}
        exceptions found.
      {:else}
        {getFilterLabel(activeIssueFilter)}
        exceptions found.
      {/if}
    </h2>
    {#if hiddenCount > 0}
      <span class="hidden-count">({hiddenCount} hidden)</span>
    {/if}
  </div>
  <p>Items missing required data or with invalid formatting.</p>

  <div class="filters">
    <label>
      <input type="checkbox" bind:checked={skipOutOfStock} />
      {#if skipOutOfStock}
        Skip out of stock ({skippedCount} skipped)
      {:else}
        Skip out of stock ({skippedCount} would be skipped)
      {/if}
    </label>

    <label>
      <input type="checkbox" bind:checked={showHidden} />
      Show hidden items
    </label>
  </div>

  <div class="summary-dashboard">
    {#each availableFilters as filter}
      <button
        class="summary-card {filter.tone}"
        class:active={activeIssueFilter === filter.code}
        on:click={() => (activeIssueFilter = filter.code)}
      >
        <span class="label">{filter.label}</span>
        <span class="value">{getFilterCount(filter.code)}</span>
      </button>
    {/each}
  </div>

  {#if visibleItems.length === 0}
    <div class="empty">All set! No items missing data (that are visible).</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Image</th>
          <th>JAN</th>
          <th>Subtype</th>
          <th>Price</th>
          <th>Cost</th>
          <th>Description</th>
          <th>Stock</th>
          <th>Missing</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {#each visibleItems as { key, item, issues } (key)}
          <tr class:hidden-row={hiddenExceptions[key]}>
            <td>
              {#if item.image}
                <div class="thumb-wrap">
                  <ImageThumbnail src={item.image} alt="Product" />
                </div>
              {:else}
                <span class="no-img">No Img</span>
              {/if}
            </td>
            <td>{item.janCode}</td>
            <td>{item.subtype}</td>
            <td>{formatEuro(item.price)}</td>
            <td>{formatYen(item.cost)}</td>
            <td class="desc">{item.description}</td>
            <td>{(item.qty || 0) - (item.shipped || 0)}</td>
            <td>
              {#each issues as entry}
                <span class="badge">{entry.label}</span>
              {/each}
            </td>
            <td>
              <button class="btn-small" on:click={() => toggleHide(key)}>
                {hiddenExceptions[key] ? "Unhide" : "Hide"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .container {
    padding: 2rem;
  }
  .header-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  .summary {
    font-size: 1.25rem;
    color: #b91c1c;
    margin: 0;
  }
  .hidden-count {
    font-size: 0.9rem;
    color: #6b7280;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }
  .summary-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 0.6rem;
    margin-bottom: 1.5rem;
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
  .summary-card.all {
    background: #f3f4f6;
    color: #111827;
  }
  .summary-card.unlisted {
    background: #fee2e2;
    color: #991b1b;
  }
  .summary-card.image {
    background: #ede9fe;
    color: #5b21b6;
  }
  .summary-card.description {
    background: #e0f2fe;
    color: #075985;
  }
  .summary-card.description-caps {
    background: #fff7ed;
    color: #9a3412;
  }
  .summary-card.price {
    background: #dcfce7;
    color: #166534;
  }
  .summary-card.cost {
    background: #fef3c7;
    color: #92400e;
  }
  .summary-card.weight {
    background: #dbeafe;
    color: #1d4ed8;
  }
  .summary-card.hs-code {
    background: #fae8ff;
    color: #a21caf;
  }
  .summary-card.country {
    background: #ecfccb;
    color: #3f6212;
  }
  .summary-card.category {
    background: #fce7f3;
    color: #9d174d;
  }
  .btn-small {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    background: white;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-small:hover {
    background: #f9fafb;
  }
  .hidden-row {
    opacity: 0.5;
    background: #f9fafb;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 1rem;
  }
  th,
  td {
    border: 1px solid #eee;
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  .thumb-wrap {
    width: 50px;
    height: 50px;
    overflow: hidden;
  }
  :global(.thumb) {
    width: 50px;
    height: 50px;
    object-fit: cover;
  }
  .no-img {
    display: inline-block;
    width: 50px;
    height: 50px;
    background: #f3f4f6;
    color: #9ca3af;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
  }
  .badge {
    background: #fee2e2;
    color: #991b1b;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-right: 4px;
    display: inline-block;
    margin-bottom: 2px;
  }
  .empty {
    margin-top: 2rem;
    color: #166534;
    font-weight: bold;
  }
</style>
