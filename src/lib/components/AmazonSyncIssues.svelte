<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    collection,
    doc,
    writeBatch,
    runTransaction,
    getDocs,
    serverTimestamp,
    onSnapshot,
    query,
    where,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store, initialSyncReady } from "$lib/store";
  import { user } from "$lib/user-store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import AmazonOfferPreparation from "./AmazonOfferPreparation.svelte";
  import { findAmazonOfferMatches } from "$lib/amazon-offer-requests";
  import { amazonSyncBrands, type AmazonSyncBrand } from "$lib/amazon-defaults";
  import AmazonProductFactsEditor from "$lib/components/AmazonProductFactsEditor.svelte";
  import {
    projectAmazonSync,
    amazonSyncIssues,
    batchAmazonSync,
    type AmazonSyncIssue,
    type AmazonSyncRow,
  } from "$lib/amazon-sync-plan";
  import { amazonExchangeRate } from "$lib/amazon-defaults";
  import { legacyImageBaselines } from "$lib/amazon-images";
  import { UK_MARKETPLACE } from "$lib/amazon-audit";
  const issueEntries = Object.entries(amazonSyncIssues).filter(
    ([key]) => key !== "all",
  ) as [AmazonSyncIssue, string][];
  let search = "",
    error = "",
    message = "",
    busy = false;
  let submitted: Record<string, string> = {};
  let issueFilter: AmazonSyncIssue = "all";
  let brandFilter: AmazonSyncBrand | "All" = "All";
  let preparingOffers: string[] = [];
  let matchRequestIds: string[] = [];
  $: matchError = matchRequestIds.includes(
    $store.amazonCatalog?.lastFailedRequestId,
  )
    ? $store.amazonCatalog.lastProbeError
    : "";
  const pendingKey = (handle: string, issue: AmazonSyncIssue) =>
    `${seller}:${issue}:${handle}`;
  $: if (Object.keys(submitted).length) {
    const seen = new Set(
      Object.values($store.amazonPreparation?.jobs || {}).map(
        (j: any) => j.publishRequestId,
      ),
    );
    const remaining = Object.fromEntries(
      Object.entries(submitted).filter(([, id]) => !seen.has(id)),
    );
    if (Object.keys(remaining).length !== Object.keys(submitted).length)
      submitted = remaining;
  }
  let requestErrors: any[] = [];
  let stopErrors = () => {},
    listener = "";
  const stops: (() => void)[] = [];
  onDestroy(() => {
    stopErrors();
    stops.forEach((stop) => stop());
  });
  $: seller = $store.amazonAudit?.sellerId || "";
  $: if ($user?.uid && listener !== $user.uid) {
    stopErrors();
    listener = $user.uid;
    // Failed requests are shown even after a reload, before any job facts exist.
    stopErrors = onSnapshot(
      query(
        collection(firestore, "request_amazon_prepare"),
        where("creator", "==", listener),
      ),
      (s) => {
        requestErrors = s.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((d: any) => d.error)
          .sort(
            (a: any, b: any) =>
              (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0),
          )
          .slice(0, 5);
      },
      (e) => (error = e.message),
    );
  }
  let baselineSeller = "";
  $: if (
    $initialSyncReady &&
    $user?.uid &&
    seller &&
    baselineSeller !== seller &&
    Object.keys($store.amazonAudit?.observations || {}).length
  ) {
    baselineSeller = seller;
    initializeImages().catch((e) => (error = e.message));
  }
  async function initializeImages() {
    // Older tabs may have advanced their cursor past facts they did not yet
    // understand. Recover only the new observation type, never replay inventory.
    if (!$store.amazonAudit?.pricing) {
      const facts = await getDocs(
        query(
          collection(firestore, "broadcast"),
          where("type", "==", "amazonAudit/pricing"),
        ),
      );
      for (const fact of facts.docs) store.dispatch(fact.data() as any);
    }
    const items = await legacyImageBaselines($store);
    if (!items.length) {
      return;
    }
    const ref = doc(
      firestore,
      "broadcast",
      `amazon-image-baseline-v1-${seller}`,
    );
    const existing = await runTransaction(firestore, async (tx) => {
      const snapshot = await tx.get(ref);
      if (snapshot.exists()) return snapshot.data();
      tx.set(ref, {
        type: "amazonAudit/imageBaselines",
        payload: {
          sellerId: seller,
          marketplaceId: UK_MARKETPLACE,
          items,
          reason:
            "Existing Amazon images accepted by the operator during source-tracking migration.",
        },
        creator: $user!.uid,
        timestamp: serverTimestamp(),
      });
      return null;
    });
    if (existing) store.dispatch(existing as any);
  }
  $: allRows = projectAmazonSync($store);
  $: rows = allRows
    .filter((r) => brandFilter === "All" || r.brand === brandFilter)
    .filter((r) =>
      `${r.title} ${r.handle} ${r.details.map((d) => d.key + " " + d.sku).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    );
  $: rate = amazonExchangeRate($store.amazonPreparation, seller);
  $: groups = issueEntries
    .map(([issue, label]) => ({
      issue,
      label,
      affected: rows.filter((r) => r.issues.includes(issue)),
    }))
    .filter((group) => group.affected.length > 0);
  $: if (issueFilter !== "all" && !groups.some((g) => g.issue === issueFilter))
    issueFilter = "all";
  $: visibleGroups = groups.filter(
    (g) => issueFilter === "all" || g.issue === issueFilter,
  );
  $: supplierRows = rows.filter((r) => r.brand !== "Amifa");
  async function findMatches(selected: AmazonSyncRow[]) {
    if (!$user?.uid) return;
    busy = true;
    error = "";
    message = "";
    try {
      const keys = selected.flatMap((r) =>
        r.details
          .filter((d) => ["offer_match", "presence"].includes(d.issue))
          .map((d) => d.key),
      );
      const result = await findAmazonOfferMatches(
        firestore,
        $user.uid,
        keys.map((k) => $store.inventory.idToItem[k]?.janCode || ""),
      );
      matchRequestIds = [...matchRequestIds, ...result.requestIds];
      message = `Searching ${result.count} barcodes on the server. Open Prepare offers to review the matches.`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  function missingDataFields(row: AmazonSyncRow) {
    const fields = new Map<string, Set<string>>();
    for (const detail of row.details.filter((d) => d.issue === "missing_data"))
      for (const field of detail.local || []) {
        if (!fields.has(field)) fields.set(field, new Set());
        fields.get(field)!.add(detail.subtype || detail.key);
      }
    return [...fields].map(([field, variants]) => ({
      field,
      variants: [...variants],
    }));
  }
  function missingDataJans(row: AmazonSyncRow) {
    return [
      ...new Set(
        row.details
          .filter((d) => d.issue === "missing_data")
          .map((d) => $store.inventory.idToItem[d.key]?.janCode || d.key),
      ),
    ].join(", ");
  }
  function displayValue(issue: AmazonSyncIssue, value: any) {
    if (issue === "quantity")
      return String(value?.[0]?.quantity ?? "Not reported");
    if (issue === "price") {
      const amount = value?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
      return amount === undefined
        ? "Not reported"
        : `GBP ${Number(amount).toFixed(2)}`;
    }
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((v) => typeof v.value === "string"))
      return value.map((v) => v.value).join("\n");
    return JSON.stringify(value, null, 2);
  }
  async function sync(selected: AmazonSyncRow[], issue: AmazonSyncIssue) {
    error = "";
    message = "";
    busy = true;
    try {
      if (!$user || !seller)
        throw Error("Sign in and refresh the Amazon catalogue first.");
      // Recompute immediately so stock, prices and mappings are current at enqueue.
      const handles = new Set(selected.map((r) => r.handle));
      const batches = batchAmazonSync(
        projectAmazonSync($store).filter((r) => handles.has(r.handle)),
        issue,
      );
      if (!batches.length)
        throw Error("No eligible changes remain in this category.");
      const batch = writeBatch(firestore);
      const refs = batches.map((entries) => {
        const ref = doc(collection(firestore, "request_amazon_prepare"));
        batch.set(ref, {
          creator: $user!.uid,
          sellerId: seller,
          marketplaceId: UK_MARKETPLACE,
          mode: "sync",
          stockConfirmed: true,
          entries,
          createdAt: serverTimestamp(),
        });
        return ref;
      });
      await batch.commit();
      const queued = { ...submitted };
      batches.forEach((entries, i) => {
        for (const row of selected)
          if (
            row.entries[issue]?.some((e) =>
              entries.some((queuedEntry) => queuedEntry.sku === e.sku),
            )
          )
            queued[pendingKey(row.handle, issue)] = refs[i].id;
      });
      submitted = queued;
      for (const ref of refs)
        stops.push(
          onSnapshot(
            ref,
            (s) => {
              if (s.data()?.error) {
                error = s.data()?.error;
                submitted = Object.fromEntries(
                  Object.entries(submitted).filter(([, id]) => id !== ref.id),
                );
              }
            },
            (e) => (error = e.message),
          ),
        );
      message = `${amazonSyncIssues[issue]} sync queued for ${selected.filter((r) => r.entries[issue]?.length).length} listing(s). The server continues if you leave this page. Hedgehoggy shows the queued work; Amazon readback can take an hour or more.`;
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="sync-issues" aria-label="Amazon sync issues">
  <h2>Amazon sync issues</h2>
  <nav class="filters" aria-label="Filter Amazon brands">
    <button
      aria-pressed={brandFilter === "All"}
      on:click={() => {
        brandFilter = "All";
        preparingOffers = [];
      }}>All brands ({allRows.length})</button
    >
    {#each amazonSyncBrands as brand}
      <button
        aria-pressed={brandFilter === brand}
        on:click={() => {
          brandFilter = brand;
          preparingOffers = [];
        }}>{brand} ({allRows.filter((r) => r.brand === brand).length})</button
      >
    {/each}
  </nav>
  {#if (brandFilter === "Pilot" || brandFilter === "All") && allRows.some((r) => r.brand === "Pilot")}<p
    >
      Pilot approval is still to be verified. You can prepare and test its
      existing-ASIN offers; any Amazon approval errors appear here.
    </p>{/if}
  <nav class="filters" aria-label="Filter Amazon sync issues">
    <button
      aria-pressed={issueFilter === "all"}
      on:click={() => (issueFilter = "all")}
      aria-label={`All listings (${rows.length})`}
      ><strong>{rows.length}</strong>All listings</button
    >
    {#each groups as { issue, label, affected }}
      <button
        aria-pressed={issueFilter === issue}
        on:click={() => (issueFilter = issue)}
        aria-label={`${label} (${affected.length})`}
        ><strong>{affected.length}</strong>{label}</button
      >
    {/each}
  </nav>
  <p>
    One row per listing. Sync listing applies all supported differences
    together. Amifa includes product content, images and relationships. Uni,
    Zebra and Pilot sync offers for existing ASINs: price and stock only. Amazon
    approvals and Featured Offer decisions remain visible when they need
    attention. Price: EUR × {rate} → GBP.
  </p>
  <p>
    <a href="/amazon-categories">Amazon category mappings and exchange rate</a>
    · {allRows.length} stocked or existing listings
  </p>
  <label
    >Search listings <input
      type="search"
      bind:value={search}
      placeholder="Title, JAN or SKU"
    /></label
  >
  {#if supplierRows.length}
    <div class="offer-actions">
      <button
        disabled={busy ||
          !$user ||
          !supplierRows.some(
            (r) =>
              r.issues.includes("offer_match") || r.issues.includes("presence"),
          )}
        on:click={() => findMatches(supplierRows)}
        >Find ASIN matches in bulk</button
      >
      <button
        on:click={() => (preparingOffers = supplierRows.map((r) => r.handle))}
        >Prepare offers ({supplierRows.length} listings)</button
      >
    </div>
  {/if}
  {#if preparingOffers.length > 1}
    <button on:click={() => (preparingOffers = [])}
      >Close offer preparation</button
    >
    <AmazonOfferPreparation handles={preparingOffers} />
  {/if}
  {#if !seller}<p>Refresh from Amazon to load your UK seller catalogue.</p>{/if}
  {#if message}<p role="status" class="message">{message}</p>{/if}
  {#if matchError}<p role="alert" class="error">{matchError}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#each requestErrors as failure}<p class="error">
      Request {failure.id}: {failure.error}
    </p>{/each}
  <button
    class="primary"
    disabled={busy ||
      !rows.some(
        (r) => r.entries.all?.length && !submitted[pendingKey(r.handle, "all")],
      )}
    on:click={() =>
      sync(
        rows.filter(
          (r) =>
            r.entries.all?.length && !submitted[pendingKey(r.handle, "all")],
        ),
        "all",
      )}
    >Sync all listings with changes ({rows.filter(
      (r) => r.entries.all?.length && !submitted[pendingKey(r.handle, "all")],
    ).length})</button
  >
  <div class="cards">
    {#each visibleGroups as { issue, label, affected } (issue)}
      {@const eligible = affected.filter(
        (r) => r.entries.all?.length && !submitted[pendingKey(r.handle, "all")],
      )}
      <details data-issue={issue}>
        <summary
          ><strong>{label}</strong><span>{affected.length} listing(s)</span
          ></summary
        >
        {#if issue !== "missing_data" && (!["attention", "processing", "synced", "category", "offer_match"].includes(issue) || eligible.length)}
          <button
            class="primary"
            disabled={busy || !eligible.length}
            on:click={() => sync(eligible, "all")}
            >Sync listings in {label.toLowerCase()} ({eligible.length})</button
          >
        {/if}
        {#if issue === "missing_data"}<p>
            Complete the fields listed for each product using Edit Amazon
            product details. Saving the missing facts updates this list
            automatically; the product can then be synced.
          </p>{/if}
        {#if issue === "category"}<p>
            <a href="/amazon-categories"
              >Set Shopify → Amazon category mappings</a
            >
          </p>{/if}
        {#if issue === "presence"}<p>
            Creates new Amifa catalogue products, or adds confirmed Uni, Zebra
            and Pilot offers to existing ASINs. Offer preparation does not
            change Amazon product content or create new ASINs.
          </p>{/if}
        {#if issue === "quantity"}<p>
            Sync listing also applies its other supported changes.
          </p>{/if}
        {#if issue === "featured_offer" || issue === "offer_unchecked"}<p>
            Refresh from Amazon to recheck. For an offer that remains
            unfeatured, review Pricing Health in <a
              href="https://sellercentral.amazon.co.uk/"
              target="_blank"
              rel="noreferrer">Seller Central</a
            >. A data sync cannot force Amazon to feature an offer.
          </p>{/if}
        {#each affected as row (row.handle)}
          <div class="listing">
            <div class="heading">
              {#if row.image}<ImageThumbnail
                  src={row.image}
                  alt={row.title}
                  width="64px"
                  height="64px"
                  fit="contain"
                />{/if}
              <div>
                <strong>{row.title}</strong><small
                  >{#if issue === "missing_data"}JAN {missingDataJans(
                      row,
                    )}{:else}{row.handle}{/if}</small
                >
              </div>
              {#if issue !== "missing_data" && row.entries.all?.length}<button
                  disabled={busy || !!submitted[pendingKey(row.handle, "all")]}
                  on:click={() => sync([row], "all")}>Sync listing</button
                >{/if}
            </div>
            {#if issue === "missing_data"}
              <ul class="missing-fields">
                {#each missingDataFields(row) as { field, variants }}
                  <li>
                    <strong>{field}</strong><small>{variants.join(" · ")}</small
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            {#if row.brand === "Amifa"}
              <AmazonProductFactsEditor handle={row.handle} />
            {:else}
              <button
                on:click={() =>
                  (preparingOffers =
                    preparingOffers.length === 1 &&
                    preparingOffers[0] === row.handle
                      ? []
                      : [row.handle])}>Prepare offers</button
              >
              {#if preparingOffers.length === 1 && preparingOffers[0] === row.handle}<AmazonOfferPreparation
                  handles={[row.handle]}
                />{/if}
            {/if}
            {#each row.details.filter((d) => d.issue === issue && issue !== "missing_data") as d}
              <div class="change">
                <strong>{d.subtype || d.key}</strong><small>SKU {d.sku}</small>
                {#if d.reason}<p>
                    {d.reason}
                  </p>{:else if ["variant_image", "gallery"].includes(issue)}
                  <div class="images">
                    <div>
                      Inventory{#each d.local || [] as image}{#if image.media_location}<ImageThumbnail
                            src={image.media_location}
                            width="90px"
                            height="90px"
                            fit="contain"
                          />{/if}{/each}
                    </div>
                    <div>
                      Amazon{#each d.remote || [] as image}{#if image.media_location}<ImageThumbnail
                            src={image.media_location}
                            width="90px"
                            height="90px"
                            fit="contain"
                          />{/if}{/each}
                    </div>
                  </div>
                {:else if issue === "presence"}<p>
                    {#if d.local?.merchant_suggested_asin?.[0]?.value}
                      Offer for <a
                        href={`https://www.amazon.co.uk/dp/${d.local.merchant_suggested_asin[0].value}`}
                        target="_blank"
                        rel="noreferrer"
                        >{d.local.merchant_suggested_asin[0].value}</a
                      >
                      · {displayValue("price", d.local.purchasable_offer)} · {displayValue(
                        "quantity",
                        d.local.fulfillment_availability,
                      )} units
                    {:else}Not yet published on Amazon.{/if}
                  </p>
                {:else}<div class="values">
                    <div>
                      <small>Inventory</small>
                      <pre>{displayValue(issue, d.local)}</pre>
                    </div>
                    <div>
                      <small>Amazon</small>
                      <pre>{displayValue(issue, d.remote)}</pre>
                    </div>
                  </div>{/if}
              </div>
            {/each}
          </div>
        {/each}
      </details>
    {/each}
  </div>
</section>

<style>
  .sync-issues {
    margin: 1.5rem 0;
  }
  input,
  button {
    padding: 0.5rem 0.75rem;
    border: 1px solid #9ca3af;
    border-radius: 5px;
  }
  button {
    cursor: pointer;
    background: #eff6ff;
    margin: 0.5rem 0;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .primary {
    background: #2563eb;
    color: white;
  }
  .cards {
    display: grid;
    gap: 0.8rem;
    margin: 1rem 0;
  }
  .filters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  .filters button {
    border-radius: 0.6rem;
    margin: 0;
    min-height: 85px;
    padding: 1rem;
    text-align: left;
    background: #f1f5f9;
    border-color: #cbd5e1;
    color: #334155;
  }
  .filters strong {
    display: block;
    font-size: 1.6rem;
    margin-bottom: 0.3rem;
  }
  .filters button[aria-pressed="true"] {
    background: #1e40af;
    color: white;
    border-color: #1e40af;
  }
  @media (max-width: 640px) {
    .filters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  details {
    border: 1px solid #d1d5db;
    border-radius: 8px;
    padding: 1rem;
    background: white;
  }
  summary {
    display: flex;
    justify-content: space-between;
    cursor: pointer;
    font-size: 1.05rem;
  }
  small {
    display: block;
    color: #6b7280;
  }
  .listing {
    border-top: 1px solid #d1d5db;
    padding: 1rem 0;
    margin-top: 0.7rem;
  }
  .missing-fields {
    list-style: disc;
    padding-left: 1.5rem;
    margin: 0.75rem 0;
  }
  .missing-fields li {
    margin: 0.5rem 0;
  }
  .heading {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .heading > div {
    flex: 1;
  }
  .change {
    padding: 0.5rem;
    margin-left: 1rem;
    border-top: 1px solid #eee;
  }
  .values,
  .images {
    display: flex;
    gap: 1rem;
  }
  .values > div,
  .images > div {
    flex: 1;
    min-width: 0;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8rem;
    max-height: 12rem;
    overflow: auto;
  }
  .error {
    color: #b91c1c;
    background: #fef2f2;
    padding: 0.7rem;
  }
  .message {
    background: #eff6ff;
    padding: 0.7rem;
  }
</style>
