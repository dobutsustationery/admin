<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    offerReviewPricing,
    localOfferImage,
  } from "$lib/amazon-offer-review";
  import { scanInventoryJans } from "$lib/amazon-scan-inventory";
  import {
    addDoc,
    collection,
    onSnapshot,
    serverTimestamp,
    query as firestoreQuery,
    orderBy,
    limit,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import {
    UK_MARKETPLACE,
    initialAmazonAudit,
    type AmazonAuditState,
  } from "$lib/amazon-audit";
  import {
    projectPreparation,
    reducePreparation,
    type PreparationDecision,
    initialPreparation,
    type PreparationRow,
  } from "$lib/amazon-preparation";
  import {
    categories,
    listingStatus,
    statusDetail,
  } from "$lib/amazon-listing-status";
  import AmazonVariationFamily from "$lib/components/AmazonVariationFamily.svelte";
  import AmazonPreparation from "$lib/components/AmazonPreparation.svelte";
  import {
    amazonCreationFamilies,
    amazonFamilyStatus,
  } from "$lib/amazon-family-view";
  let editingFamily = "";
  $: creationFamilies = amazonCreationFamilies(
    rows,
    $store.listings.handleToListing,
  );
  $: familyStatuses = new Map(
    [...creationFamilies].map(([handle, members]) => [
      handle,
      amazonFamilyStatus(members, prep.jobs, audit.sellerId, now),
    ]),
  );
  const viewStatus = (r: PreparationRow) =>
    familyStatuses.get(r.row.family) || listingStatus(r, now);
  let query = "",
    category = "All",
    brand = "All",
    message = "",
    error = "",
    busy = false;
  let now = Date.now(),
    refreshStarted = 0,
    reviewKeys: string[] = [],
    confirmed = false;
  let selected = new Set<string>(),
    editKey = "",
    price = "",
    productType = "",
    sku = "",
    factor = "";
  let legacyDraft = false,
    asin = "",
    asinVerified = false,
    hideZero = false;
  let matchRequestIds: string[] = [];
  let includeZeroStock = false;
  let scanLimit = "",
    negativeBefore = "",
    scans: any[] = [],
    scanListener = "";
  let stopScans = () => {};
  onDestroy(() => stopScans());
  $: if ($user?.uid && scanListener !== $user.uid) {
    stopScans();
    scanListener = $user.uid;
    stopScans = onSnapshot(
      firestoreQuery(
        collection(firestore, "amazon_catalog_scans"),
        orderBy("startedAt", "desc"),
        limit(10),
      ),
      (s) => (scans = s.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (e) => (error = e.message),
    );
  }
  $: scan = scans.find(
    (s) => s.sellerId === audit.sellerId && s.marketplaceId === UK_MARKETPLACE,
  );
  $: inventoryJans = scanInventoryJans(
    $store.inventory.idToItem || {},
    includeZeroStock,
  );
  function startScan() {
    return run(async () => {
      const cap = String(scanLimit ?? "").trim() ? Number(scanLimit) : null;
      if (cap !== null && (!Number.isInteger(cap) || cap < 1))
        throw Error(
          "Enter a positive whole-number test limit, or leave it blank for all.",
        );
      await enqueue("request_amazon_catalog_scan", {
        marketplaceId: UK_MARKETPLACE,
        jans: inventoryJans,
        limit: cap,
        negativeBefore: negativeBefore
          ? new Date(negativeBefore + "T00:00:00").getTime()
          : null,
      });
      message =
        "Server scan requested. You can close this browser; the server will continue and save its progress.";
    });
  }
  const stops: (() => void)[] = [];
  onDestroy(() => stops.forEach((stop) => stop()));
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 10000);
    return () => clearInterval(timer);
  });
  $: audit = ($store.amazonAudit || initialAmazonAudit) as AmazonAuditState;
  $: prep = $store.amazonPreparation || initialPreparation;
  $: rows = projectPreparation(
    prep,
    audit,
    $store.inventory,
    $store.listings,
    undefined,
    $store.amazonCatalog,
  );
  const brandOf = (r: PreparationRow) =>
    String(
      $store.inventory.idToItem[r.row.key]?.manufacturer ||
        $store.inventory.idToItem[r.row.key]?.brand ||
        "Unspecified",
    );
  $: brands = [...new Set(rows.map(brandOf))].sort();
  $: searched = rows.filter(
    (r) =>
      (brand === "All" || brandOf(r) === brand) &&
      `${r.row.title} ${r.row.subtype} ${r.row.jan} ${r.row.sku}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  $: visible = searched.filter(
    (r) =>
      (category === "All" || viewStatus(r) === category) &&
      (!hideZero || r.row.onHand !== 0),
  );
  $: families = [...new Set(visible.map((r) => r.row.family || r.row.key))];
  $: chosen = visible.filter(
    (r) => !creationFamilies.has(r.row.family) && selected.has(r.row.key),
  );
  $: checkable = chosen.filter(
    (r) =>
      [
        "New listings",
        "Add offers",
        "Zero stock",
        "Updates needed",
        "Failed",
      ].includes(listingStatus(r, now)) &&
      r.entry &&
      r.job?.status !== "unknown",
  );
  $: ready = chosen.filter((r) => listingStatus(r, now) === "Ready to publish");
  $: review = rows.filter((r) => reviewKeys.includes(r.row.key));
  $: canPublish =
    review.length === reviewKeys.length &&
    review.length > 0 &&
    review.every((r) => listingStatus(r, now) === "Ready to publish");
  $: latest = Object.values(audit.runs)
    .filter(
      (r) =>
        r.mode === "catalogue" &&
        r.sellerId === audit.sellerId &&
        r.marketplaceId === UK_MARKETPLACE,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  $: lastSuccess = Object.values(audit.runs)
    .filter(
      (r) =>
        r.mode === "catalogue" &&
        r.sellerId === audit.sellerId &&
        r.marketplaceId === UK_MARKETPLACE &&
        r.status === "complete",
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  $: if (
    refreshStarted &&
    latest &&
    latest.startedAt >= refreshStarted &&
    latest.status !== "waiting"
  ) {
    message =
      latest.status === "complete"
        ? `Refresh complete: ${latest.count} Amazon seller listings read.`
        : `Refresh incomplete: ${latest.error || latest.status}`;
    refreshStarted = 0;
  }
  $: suggestions =
    (Object.values($store.amazonCatalog?.rawResponsesById || {}) as any[])
      .filter(
        (v) =>
          v.kind === "product_type_search" &&
          v.key === rows.find((r) => r.row.key === editKey)?.row.title &&
          v.sellerId === audit.sellerId &&
          v.marketplaceId === UK_MARKETPLACE,
      )
      .sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0]?.raw?.productTypes ||
    [];
  const date = (n: number) => (n ? new Date(n).toLocaleString() : "Never");
  async function run(fn: () => Promise<void>) {
    if (!$user?.uid) {
      error = "Sign in to continue.";
      return;
    }
    busy = true;
    error = "";
    try {
      await fn();
    } catch (e: any) {
      error = e.message || "The request failed.";
    } finally {
      busy = false;
    }
  }
  async function enqueue(name: string, data: any) {
    const ref = await addDoc(collection(firestore, name), {
      ...data,
      creator: $user!.uid,
      createdAt: serverTimestamp(),
    });
    stops.push(
      onSnapshot(
        ref,
        (s) => {
          if (s.data()?.error) {
            error = s.data()?.error;
            refreshStarted = 0;
          }
        },
        (e) => {
          error = e.message;
          refreshStarted = 0;
        },
      ),
    );
  }
  async function fact(type: string, payload: any) {
    await addDoc(collection(firestore, "broadcast"), {
      type,
      payload: { sellerId: audit.sellerId, ...payload },
      creator: $user!.uid,
      timestamp: serverTimestamp(),
    });
  }
  let offerKeys: string[] = [];
  let offersCollapsed = false;
  let offerSeller = "";
  let offerChoices: Record<string, PreparationDecision> = {};
  let trackedOfferKeys: string[] = [];
  $: offerCandidates = chosen.filter(
    (r) => listingStatus(r, now) === "Add offers",
  );
  $: categoryOffers = visible.filter(
    (r) => listingStatus(r, now) === "Add offers",
  );
  $: reviewPricing = offerReviewPricing(prep, audit.sellerId, $user?.uid || "");
  $: pricedOfferRows = projectPreparation(
    reviewPricing.prep,
    audit,
    $store.inventory,
    $store.listings,
    undefined,
    $store.amazonCatalog,
  );
  $: offerPrep = Object.entries(offerChoices).reduce(
    (state, [itemKey, decision]) =>
      reducePreparation(state, {
        type: "amazonPrepare/decision",
        payload: { sellerId: offerSeller, itemKey, decision },
      }),
    reviewPricing.prep,
  );
  $: offerRows = projectPreparation(
    offerPrep,
    audit,
    $store.inventory,
    $store.listings,
    undefined,
    $store.amazonCatalog,
  ).filter((r) => offerKeys.includes(r.row.key));
  $: offersToCheck = offerRows.filter(
    (r) =>
      offerSeller === audit.sellerId &&
      r.entry?.body?.requirements === "LISTING_OFFER_ONLY" &&
      ["Add offers", "Failed"].includes(listingStatus(r, now)) &&
      r.job?.status !== "unknown",
  );
  $: trackedOffers = rows.filter((r) => trackedOfferKeys.includes(r.row.key));
  $: trackedReady = trackedOffers.filter(
    (r) => listingStatus(r, now) === "Ready to publish",
  );
  async function scrollToPanel(id: string) {
    await tick();
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function prepareOffers(batch: PreparationRow[]) {
    offersCollapsed = false;
    const eligible = batch
      .filter((r) => listingStatus(r, now) === "Add offers")
      .slice(0, 100);
    offerSeller = audit.sellerId;
    offerKeys = eligible.map((r) => r.row.key);
    offerChoices = Object.fromEntries(
      eligible.map((r) => [
        r.row.key,
        {
          asin:
            r.decision.asin ||
            (r.offerMatch?.candidates.length === 1
              ? r.offerMatch.candidates[0].asin
              : ""),
          asinVerified: r.decision.asinVerified === true,
          priceGBP:
            (pricedOfferRows.find((p) => p.row.key === r.row.key)?.price || 0) >
            0
              ? pricedOfferRows
                  .find((p) => p.row.key === r.row.key)!
                  .price.toFixed(2)
              : "",
        },
      ]),
    );
    scrollToPanel("prepare-offers");
  }
  function changeOffer(key: string, change: PreparationDecision) {
    offerChoices = {
      ...offerChoices,
      [key]: { ...offerChoices[key], ...change },
    };
  }
  function checkOffers() {
    return run(async () => {
      const batch = offersToCheck.slice(0, 100);
      if (!batch.length)
        throw Error("Confirm an exact ASIN match and a valid GBP price first.");
      // Save only the rows being checked; incomplete rows stay in the panel.
      for (const r of batch)
        await fact("amazonPrepare/decision", {
          itemKey: r.row.key,
          decision: offerChoices[r.row.key],
        });
      await enqueue("request_amazon_prepare", {
        sellerId: audit.sellerId,
        marketplaceId: UK_MARKETPLACE,
        mode: "preview",
        entries: batch.map((r) => r.entry),
      });
      trackedOfferKeys = [
        ...new Set([...trackedOfferKeys, ...batch.map((r) => r.row.key)]),
      ];
      selected = new Set(trackedOfferKeys);
      offerKeys = offerKeys.filter(
        (key) => !batch.some((r) => r.row.key === key),
      );
      message = `Checking ${batch.length} offers with Amazon. Nothing published. Review successful checks below, then publish them together.`;
      scrollToPanel("offer-batch-status");
    });
  }
  function refresh(skus?: string[]) {
    return run(async () => {
      if (!skus) refreshStarted = Date.now();
      message = "Requesting current listings from Amazon...";
      try {
        await enqueue("request_amazon_audit", {
          marketplaceId: UK_MARKETPLACE,
          mode: skus ? "selected" : "catalogue",
          skus: skus || [],
        });
        message = "Refresh requested. Progress and results will appear here.";
      } catch (e) {
        refreshStarted = 0;
        throw e;
      }
    });
  }
  function check(batch: PreparationRow[]) {
    return run(async () => {
      await enqueue("request_amazon_prepare", {
        sellerId: audit.sellerId,
        marketplaceId: UK_MARKETPLACE,
        mode: "preview",
        entries: batch.slice(0, 100).map((r) => r.entry),
      });
      message = `Checking ${Math.min(batch.length, 100)} variants. Nothing has been published. Track them under In progress, Ready to publish or Failed.`;
    });
  }
  function openReview(batch: PreparationRow[]) {
    reviewKeys = batch.slice(0, 100).map((r) => r.row.key);
    confirmed = false;
    scrollToPanel("publish-review");
  }
  function publish() {
    return run(async () => {
      if (!canPublish || !confirmed)
        throw Error(
          "Review the current quantities and recheck expired validations before publishing.",
        );
      await enqueue("request_amazon_prepare", {
        sellerId: audit.sellerId,
        marketplaceId: UK_MARKETPLACE,
        mode: "publish",
        jobIds: review.map((r) => r.job.id),
        stockConfirmed: true,
      });
      reviewKeys = [];
      message =
        "Publication requested. Each result stays visible while Amazon processes and verifies it.";
    });
  }
  function edit(r: PreparationRow) {
    editKey = r.row.key;
    price = r.price > 0 ? String(r.price) : "";
    productType = r.productType;
    sku = r.row.sku;
    asin = r.decision.asin || "";
    asinVerified = r.decision.asinVerified === true;
  }
  function save(r: PreparationRow) {
    return run(async () => {
      if (
        price &&
        (!Number.isFinite(Number(price)) ||
          Number(price) <= 0 ||
          !/^\d+(\.\d{1,2})?$/.test(price))
      )
        throw Error(
          "Enter a positive GBP price with no more than two decimal places.",
        );
      if (
        asin.trim() &&
        (!/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase()) || !asinVerified)
      )
        throw Error(
          "Enter a valid ASIN and confirm the exact variant and pack size, or clear the ASIN.",
        );
      await fact("amazonPrepare/decision", {
        itemKey: r.row.key,
        decision: {
          ...(price ? { priceGBP: price } : {}),
          productType: productType.trim().toUpperCase(),
          asin: asin.trim().toUpperCase(),
          asinVerified: !!asin.trim() && asinVerified,
        },
      });
      if (sku.trim() !== r.row.sku) {
        await fact("amazonAudit/map", {
          marketplaceId: UK_MARKETPLACE,
          itemKey: r.row.key,
          sku: sku.trim(),
        });
        if (sku.trim())
          await enqueue("request_amazon_audit", {
            marketplaceId: UK_MARKETPLACE,
            mode: "selected",
            skus: [sku.trim()],
          });
      }
      editKey = "";
      message =
        "Choices saved. Nothing published. Check this product when it is ready.";
    });
  }
  function exclude(r: PreparationRow, value: boolean) {
    return run(async () => {
      await fact("amazonPrepare/decision", {
        itemKey: r.row.key,
        decision: { deferred: value, included: !value },
      });
      message = value
        ? "Product excluded from Amazon sync. Existing Amazon offers are unchanged."
        : "Product returned to the comparison.";
    });
  }
  function findMatches(batch: PreparationRow[]) {
    return run(async () => {
      const jans = [
        ...new Set(
          batch
            .filter((r) => !r.row.asin && r.row.onHand > 0)
            .map((r) => r.row.jan)
            .filter((j) => /^\d{13}$/.test(j)),
        ),
      ].slice(0, 20);
      if (!jans.length)
        throw Error(
          "Select in-stock products with valid barcodes and no existing offer.",
        );
      const ref = await addDoc(
        collection(firestore, "request_amazon_catalog_probe"),
        {
          creator: $user!.uid,
          eventType: "amazon/catalog_probe_requested",
          jans,
          includeSellerListings: false,
          source: "amazon-listings",
          createdAt: serverTimestamp(),
        },
      );
      matchRequestIds = [...matchRequestIds, ref.id];
      message = `Searching Amazon for ${jans.length} barcodes. Matches appear under Add offers; confirm the exact variant before saving.`;
    });
  }
  $: matchingResults = (
    Object.values($store.amazonCatalog?.rawResponsesById || {}) as any[]
  ).filter(
    (v) =>
      matchRequestIds.includes(v.requestId) &&
      v.kind === "catalog_search_by_jan",
  );
  $: if (matchRequestIds.includes($store.amazonCatalog?.lastFailedRequestId))
    error =
      $store.amazonCatalog.lastProbeError ||
      "Amazon catalogue lookup failed. Retry Find ASIN matches.";
  function discover(r: PreparationRow) {
    return run(async () => {
      await enqueue("request_amazon_product_type_discovery", {
        eventType: "amazon/product_type_discovery_requested",
        requestedBy: $user!.uid,
        source: "amazon-listings",
        handle: r.row.family,
        itemKey: r.row.key,
        itemName: r.row.title,
        keywords: [],
        requirements: "LISTING",
        requirementsEnforced: "ENFORCED",
        maxDefinitions: 5,
        locale: "en_GB",
        searchLocale: "en_GB",
        createdAtMs: Date.now(),
        timestamp: serverTimestamp(),
      });
      message =
        "Looking up product types. Suggestions will appear in this product panel.";
    });
  }
</script>

<svelte:head><title>Amazon listings</title></svelte:head>
<main>
  <header>
    <div>
      <h1>Amazon listings</h1>
      <p>
        Compare your catalogue with Amazon UK, resolve exceptions and sync
        changes.
      </p>
    </div>
    <button
      class="primary"
      disabled={busy || !!refreshStarted || latest?.status === "waiting"}
      on:click={() => refresh()}
      >{refreshStarted || latest?.status === "waiting"
        ? "Refreshing from Amazon..."
        : "Refresh from Amazon"}</button
    >
  </header>
  <div class="status" aria-live="polite">
    <strong>Last successful refresh: {date(lastSuccess?.updatedAt || 0)}</strong
    ><span
      >{lastSuccess
        ? `${lastSuccess.count} seller listings read`
        : "Refresh Amazon to start comparing."}</span
    >{#if latest?.status === "waiting"}<p>
        Reading Amazon: {latest.count} listings received so far.
      </p>{/if}{#if latest && !["waiting", "complete"].includes(latest.status)}<p
        role="alert"
      >
        Refresh incomplete: {latest.error || latest.status}
      </p>{/if}{#if message}<p role="status">{message}</p>{/if}{#if error}<p
        role="alert"
        class="error"
      >
        {error}
      </p>{/if}
  </div>
  <p class="muted">
    Existing offers: price and merchant-fulfilled stock comparison.
    Existing-ASIN offers and stock-only updates to zero are supported. Open a
    product below and choose “Prepare variant family” to create new Amifa
    parent/child listings. Product-detail updates for existing ASINs remain
    separate. Counts below are product listings; a listing may appear in
    multiple categories when its variants differ.
  </p>
  <section class="status" aria-label="Inventory ASIN scan">
    <h2>Find ASINs across the inventory</h2>
    <p>
      Scan {inventoryJans.length} distinct valid inventory barcodes
      {includeZeroStock
        ? "including zero-stock products"
        : "with stock on hand"}. Skipped zero-stock items remain eligible when
      restocked. Already matched barcodes and recent verified no-match results
      are skipped. Closing the browser does not stop the scan.
    </p>
    <label
      ><input
        type="checkbox"
        bind:checked={includeZeroStock}
        disabled={scan?.status === "running"}
      /> Include zero-stock items</label
    >
    <div class="actions">
      <label
        >Recheck no-ASIN results from before (optional)<input
          type="date"
          bind:value={negativeBefore}
        /></label
      ><label
        >Test limit: next N eligible barcodes (blank means all)<input
          type="number"
          min="1"
          max="20000"
          step="1"
          bind:value={scanLimit}
        /></label
      ><button
        class="primary"
        disabled={busy ||
          !$store.inventory.initialized ||
          !inventoryJans.length ||
          scan?.status === "running"}
        on:click={startScan}
        >{scan?.status === "running"
          ? "Server scan running"
          : "Scan inventory for ASINs"}</button
      >
    </div>
    {#if scan}<div aria-live="polite">
        <strong
          >{scan.status === "running"
            ? "Scanning on the server"
            : scan.status === "limited"
              ? "Test limit reached"
              : scan.status === "complete"
                ? "Scan complete"
                : "Scan stopped"}</strong
        >
        <p>
          {scan.cursor} / {scan.jans.length} barcodes reviewed; {scan.skipped} already
          checked and skipped. {scan.searched} searched: {scan.matched} with matches,
          {scan.noMatch} verified without an ASIN, {scan.failed} failed.
        </p>
        <p>
          Started {date(scan.startedAt)}. Last update {date(scan.updatedAt)}.
        </p>
        {#if scan.lastError}<p role="status">
            {scan.lastError}
          </p>{/if}{#if scan.status === "running" && scan.attempt > 0 && scan.dueAt > now}<p
          >
            Next retry after {date(scan.dueAt)}. No action needed.
          </p>{/if}{#if scan.failures?.length}<details>
            <summary>Failed barcodes ({scan.failed}; latest 100 shown)</summary
            >{#each scan.failures as failure}<p>
                {failure.jan}: {failure.error}
              </p>{/each}
            <p>
              Failed lookups are not marked as no-ASIN. Start another scan to
              retry them.
            </p>
          </details>{/if}
      </div>{/if}
  </section>
  <section class="cards" aria-label="Sync categories">
    <button
      class:current={category === "All"}
      on:click={() => (category = "All")}
      ><strong
        >{new Set(searched.map((r) => r.row.family || r.row.key)).size}</strong
      >All listings</button
    >{#each categories as c}<button
        class:current={category === c}
        on:click={() => (category = c)}
        ><strong
          >{new Set(
            searched
              .filter((r) => viewStatus(r) === c)
              .map((r) => r.row.family || r.row.key),
          ).size}</strong
        >{c}</button
      >{/each}
  </section>
  <details class="settings">
    <summary>Pricing and saved preparation choices</summary>
    <p>
      Set a default GBP price per EUR for products without an existing Amazon
      price. This is your pricing policy, not an exchange-rate lookup.
      Individual prices take priority.
    </p>
    <label
      >GBP per EUR <input
        type="number"
        min="0.001"
        step="0.001"
        bind:value={factor}
      /></label
    ><button
      disabled={busy || !(Number(factor) > 0)}
      on:click={() =>
        run(async () => {
          await fact("amazonPrepare/policy", { gbpPerEur: String(factor) });
          message =
            "Pricing policy saved. Validate and review products before publishing.";
        })}>Save pricing policy</button
    >
    <p>
      Previous preparation drafts are retained but are not applied automatically
      to this comparison.
    </p>
    <button on:click={() => (legacyDraft = !legacyDraft)}
      >{legacyDraft
        ? "Close saved draft"
        : "Review saved preparation draft"}</button
    >{#if legacyDraft}<AmazonPreparation />{/if}
  </details>
  {#if matchRequestIds.length}<p role="status">
      Amazon barcode lookup: {matchingResults.length} results received. {matchingResults.filter(
        (r) => !r.ok,
      ).length} failed. Open a product to review matches.
    </p>{/if}
  <label class="inline"
    ><input type="checkbox" bind:checked={hideZero} />Hide zero-stock products
    (does not change Amazon stock)</label
  >
  {#if category === "Add offers"}
    <section class="review">
      <h2>Add offers to existing Amazon products</h2>
      <p>
        1. Confirm the exact ASIN and GBP price for each variant. 2. Check the
        offers with Amazon. 3. Review and publish the successful checks. Finding
        a barcode match alone does not confirm the variant or pack size.
      </p>
      <button
        class="primary"
        disabled={busy || !categoryOffers.length}
        on:click={() => prepareOffers(categoryOffers)}
        >Prepare offers for this category ({Math.min(
          categoryOffers.length,
          100,
        )})</button
      >
      <p>
        Up to 100 variants per batch. You can also select specific products
        below or expand a product and choose Prepare offer.
      </p>
    </section>
  {/if}
  <div class="toolbar">
    <label
      >Find products<input
        type="search"
        bind:value={query}
        placeholder="Product, barcode or Amazon SKU"
      /></label
    ><label
      >Brand / manufacturer<select bind:value={brand}
        ><option>All</option>{#each brands as b}<option>{b}</option
          >{/each}</select
      ></label
    >{#if visible.some((r) => !creationFamilies.has(r.row.family))}<button
        on:click={() =>
          (selected = new Set(
            visible
              .filter((r) => !creationFamilies.has(r.row.family))
              .map((r) => r.row.key),
          ))}>Select this category</button
      ><button on:click={() => (selected = new Set())}>Clear</button>
      <button
        class="primary"
        disabled={busy || !offerCandidates.length}
        on:click={() => prepareOffers(offerCandidates)}
        >Prepare {Math.min(offerCandidates.length, 100)} selected offers</button
      ><button
        disabled={busy || !checkable.length}
        on:click={() => check(checkable)}
        >Check {Math.min(checkable.length, 100)} selected with Amazon</button
      ><button
        class="primary"
        disabled={busy || !ready.length}
        on:click={() => openReview(ready)}
        >Review {Math.min(ready.length, 100)} ready to publish</button
      ><button
        disabled={busy || !chosen.some((r) => !r.row.asin && r.row.onHand > 0)}
        on:click={() => findMatches(chosen)}
        >Find ASIN matches (up to 20 barcodes)</button
      ><span
        >{chosen.length} variants selected in this view. Batches contain up to 100.</span
      >{/if}
  </div>
  {#if offerKeys.length}
    <section
      class="review"
      id="prepare-offers"
      aria-label="Prepare Amazon offers"
    >
      <div class="actions">
        <h2>Prepare offers ({offerRows.length})</h2>
        <button
          type="button"
          aria-expanded={!offersCollapsed}
          aria-controls="prepare-offers-content"
          on:click={() => (offersCollapsed = !offersCollapsed)}
          >{offersCollapsed
            ? "Expand preparation"
            : "Collapse preparation"}</button
        >
      </div>
      {#if offersCollapsed}<p>
          {offersToCheck.length} ready to check. Your choices are kept while this
          section is collapsed.
        </p>{/if}
      <div id="prepare-offers-content" hidden={offersCollapsed}>
        <p>
          Compare our product with the Amazon match and confirm the exact
          variant and pack size. Prices are filled from existing pricing where
          available. Confirm only matches you have verified, including colour
          and pack size. No product type is required for these existing-ASIN
          offers.
        </p>
        {#if offerSeller !== audit.sellerId}<p role="alert">
            Seller changed. Close this panel and prepare the offers again.
          </p>{/if}
        {#if reviewPricing.factor}<p>
            Catalogue prices use your saved GBP factor: EUR price × {reviewPricing.factor}.
            Existing Amazon prices and individual overrides take priority.
          </p>{/if}
        {#each offerRows as r}
          {@const choice = offerChoices[r.row.key]}
          {@const ourPhoto = localOfferImage(
            r.row,
            $store.inventory,
            $store.listings,
            $store.photos,
          )}
          {@const candidate = r.offerMatch?.candidates.find(
            (c) => c.asin === choice.asin,
          )}
          <article class="resolve">
            <h3>{r.row.title} {r.row.subtype}</h3>
            <p>Barcode {r.row.jan} · {r.row.onHand} units in stock</p>
            <label
              >Amazon product for {r.row.subtype || r.row.title}
              <select
                value={choice.asin || ""}
                on:change={(e) =>
                  changeOffer(r.row.key, {
                    asin: e.currentTarget.value,
                    asinVerified: false,
                  })}
              >
                <option value="">Choose an exact match</option>
                {#each r.offerMatch?.candidates || [] as candidate}<option
                    value={candidate.asin}
                    >{candidate.title} ({candidate.asin})</option
                  >{/each}
                {#if choice.asin && !r.offerMatch?.candidates.some((c) => c.asin === choice.asin)}<option
                    value={choice.asin}>{choice.asin} (saved ASIN)</option
                  >{/if}
              </select>
            </label>
            <div class="offer-comparison">
              <div>
                <strong>{ourPhoto.label}</strong>
                {#if ourPhoto.url}<ImageThumbnail
                    src={ourPhoto.url}
                    alt={`Our ${r.row.title} ${r.row.subtype}`}
                    width="100%"
                    height="180px"
                    fit="contain"
                  />{:else}<div class="missing-photo">
                    No local image available
                  </div>{/if}
                <p>{r.row.title} {r.row.subtype}</p>
                <p>
                  Catalogue: {Number(
                    $store.inventory.idToItem[r.row.key]?.price,
                  ) > 0
                    ? `EUR ${Number($store.inventory.idToItem[r.row.key].price).toFixed(2)}`
                    : "price unavailable"}
                </p>
              </div>
              <div>
                <strong>Amazon product</strong>
                {#if candidate?.image}<ImageThumbnail
                    src={candidate.image}
                    alt={candidate.title}
                    width="100%"
                    height="180px"
                    fit="contain"
                  />{:else}<div class="missing-photo">
                    {choice.asin
                      ? "Amazon image unavailable"
                      : "Choose an Amazon match"}
                  </div>{/if}
                <p>{candidate?.title || choice.asin || "No ASIN selected"}</p>
                {#if candidate?.brand}<p>{candidate.brand}</p>{/if}
                {#if choice.asin}<a
                    href={`https://www.amazon.co.uk/dp/${choice.asin}`}
                    target="_blank"
                    rel="noreferrer">Open Amazon product</a
                  >{/if}
              </div>
            </div>
            <p>
              <strong
                >Offer price: {Number(choice.priceGBP) > 0
                  ? `GBP ${Number(choice.priceGBP).toFixed(2)}`
                  : "price needed"}</strong
              >
              · Stock: {r.row.onHand}
            </p>
            <details open={!(Number(choice.priceGBP) > 0)}>
              <summary
                >{Number(choice.priceGBP) > 0
                  ? "Change price (optional)"
                  : "Set missing GBP price"}</summary
              >
              <label
                >GBP offer price for {r.row.subtype || r.row.title}<input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={choice.priceGBP || ""}
                  on:input={(e) =>
                    changeOffer(r.row.key, { priceGBP: e.currentTarget.value })}
                /></label
              >
            </details>
            <label class="inline"
              ><input
                type="checkbox"
                checked={choice.asinVerified === true}
                disabled={!choice.asin}
                on:change={(e) =>
                  changeOffer(r.row.key, {
                    asinVerified: e.currentTarget.checked,
                  })}
              />I verified the ASIN matches this exact product, variant and pack
              size.</label
            >
            {#if r.reason}<p>{r.reason}</p>{:else}<p>
                Ready to check with Amazon. This will not publish the offer.
              </p>{/if}
          </article>
        {/each}
        <p>
          {offersToCheck.length} ready to check; {offerRows.length -
            offersToCheck.length} still need attention.
        </p>
        <button
          class="primary"
          disabled={busy || !offersToCheck.length}
          on:click={checkOffers}
          >Save and check {offersToCheck.length} offers with Amazon</button
        >
        <button
          disabled={busy}
          on:click={() => {
            offerKeys = [];
            offerChoices = {};
          }}>Close preparation</button
        >
      </div>
    </section>
  {/if}
  {#if trackedOffers.length}
    <section
      class="review"
      id="offer-batch-status"
      aria-label="Offer batch status"
    >
      <h2>Your offer batch</h2>
      {#each trackedOffers as r}<p>
          <strong>{r.row.title} {r.row.subtype}</strong>: {listingStatus(
            r,
            now,
          )}. {statusDetail(r, now)}
        </p>{/each}
      <button
        class="primary"
        disabled={busy || !trackedReady.length}
        on:click={() => openReview(trackedReady)}
        >Review and publish {trackedReady.length} checked offers</button
      >
      <p>
        Only successfully checked offers can be published. After reopening this
        page, find them in Ready to publish.
      </p>
    </section>
  {/if}
  {#if reviewKeys.length}<section
      class="review"
      id="publish-review"
      aria-label="Review Amazon changes"
    >
      <h2>Review changes before publishing</h2>
      <p>
        Only these products will be submitted. Prices are GBP; quantities are
        saleable units.
      </p>
      {#each review as r}<p>
          <strong>{r.row.title} {r.row.subtype}</strong> — {r.entry?.body
            ?.requirements === "LISTING_OFFER_ONLY"
            ? `Add offer to ASIN ${r.decision.asin}`
            : r.entry?.method === "PUT"
              ? "Create listing"
              : "Update offer"}: {r.row.onHand === 0
            ? "stock-only update; price unchanged"
            : `price ${r.row.price} → GBP ${r.price.toFixed(2)}`}; stock {r.row
            .quantity ?? "not listed"} → {r.row.onHand}
        </p>{/each}{#if !canPublish}<p role="alert">
          A product changed or its validation expired. Close this review and
          check it again.
        </p>{/if}<label class="inline"
        ><input type="checkbox" bind:checked={confirmed} />I have checked these
        quantities, including recent Amazon sales not yet recorded here.</label
      ><button
        class="primary"
        disabled={busy || !confirmed || !canPublish}
        on:click={publish}>Publish these {review.length} products</button
      ><button on:click={() => (reviewKeys = [])}>Cancel</button>
    </section>{/if}
  {#if !$store.inventory.initialized}<p role="status">
      Loading your catalogue...
    </p>{:else if !visible.length}<p>
      No products in this category match your filters.
    </p>{/if}
  {#each families as family}
    {@const members = visible.filter(
      (r) => (r.row.family || r.row.key) === family,
    )}
    {@const newFamily = creationFamilies.get(family)}
    <details class="family">
      <summary
        ><strong>{members[0].row.title}</strong><span
          >{newFamily?.length || members.length} variant{(newFamily?.length ||
            members.length) === 1
            ? ""
            : "s"} · {[...new Set(members.map(viewStatus))].join(" / ")}</span
        ></summary
      >
      {#if newFamily}
        <article aria-label="New Amazon variant family">
          {#if editingFamily === family}
            <AmazonVariationFamily
              {rows}
              familyHandle={family}
              exemptionSelected={newFamily.some((r) => r.row.sharedJan)}
            />
          {:else}
            <p>
              One Amazon product with {newFamily.length} variants. Set and review
              their Amazon GBP prices together when preparing the family.
            </p>
            <table class="family-variants">
              <thead
                ><tr
                  ><th>Variant</th><th>Photo</th><th>JAN</th><th
                    >Local price (EUR)</th
                  ><th>Available stock</th></tr
                ></thead
              ><tbody>
                {#each newFamily as r}<tr
                    ><td
                      >{r.row.subtype ||
                        $store.listings.handleToListing[family]
                          ?.variantOptionsByItemId?.[r.row.key] ||
                        r.row.jan}</td
                    ><td
                      ><ImageThumbnail
                        src={$store.inventory.idToItem[r.row.key]?.image || ""}
                        alt={r.row.subtype}
                        width="64px"
                        height="64px"
                        fit="contain"
                      /></td
                    ><td>{r.row.jan}</td><td
                      >€{Number(
                        $store.inventory.idToItem[r.row.key]?.price || 0,
                      ).toFixed(2)}</td
                    ><td>{r.row.onHand}</td></tr
                  >{/each}
              </tbody>
            </table>
            <button
              class="primary"
              disabled={busy || !audit.sellerId}
              on:click={() => (editingFamily = family)}
              >{familyStatuses.get(family) === "New listings" ||
              familyStatuses.get(family) === "Zero stock"
                ? "Prepare variant family"
                : "Review variant family"}</button
            >
            {#if newFamily.some((r) => r.row.sharedJan)}<p>
                Uses your Amifa GTIN exemption for variants sharing a JAN.
              </p>{/if}
          {/if}
        </article>
      {:else}
        {#each members as r}{@const status = listingStatus(r, now)}
          <article>
            <div class="rowhead">
              <label class="inline"
                ><input
                  type="checkbox"
                  checked={selected.has(r.row.key)}
                  on:change={() => {
                    const next = new Set(selected);
                    next.has(r.row.key)
                      ? next.delete(r.row.key)
                      : next.add(r.row.key);
                    selected = next;
                  }}
                />{r.row.subtype || "Single variant"}
                <small>{r.row.jan}</small></label
              ><strong class:failed={status === "Failed"}>{status}</strong>
            </div>
            <p>{statusDetail(r, now)}</p>
            <div class="values">
              <span
                >Amazon: {r.row.price} · stock {r.row.quantity ??
                  "not observed"}</span
              ><span
                >Proposed: {r.price > 0
                  ? `GBP ${r.price.toFixed(2)}`
                  : "price needed"} · stock {r.row.onHand}</span
              ><small>Observed {date(r.row.checkedAt)}</small>
            </div>
            <div class="actions">
              {#if status === "Add offers"}<button
                  class="primary"
                  disabled={busy}
                  on:click={() => prepareOffers([r])}>Prepare offer</button
                >{/if}
              {#if ["New listings", "Add offers", "Zero stock", "Updates needed", "Failed"].includes(status) && r.entry && r.job?.status !== "unknown"}<button
                  disabled={busy}
                  on:click={() => check([r])}
                  >{status === "Failed"
                    ? "Retry validation"
                    : "Check with Amazon"}</button
                >{/if}
              {#if status === "Ready to publish"}<button
                  class="primary"
                  on:click={() => openReview([r])}>Review and publish</button
                >{/if}
              {#if r.row.sku}<button
                  disabled={busy}
                  on:click={() => refresh([r.row.sku])}
                  >Refresh this offer</button
                >{/if}
              <button
                on:click={() =>
                  editKey === r.row.key ? (editKey = "") : edit(r)}
                >{status === "Needs your input"
                  ? "Resolve"
                  : "Edit choices"}</button
              >
              {#if !/\bnot for sale\b/i.test(r.row.title)}<button
                  disabled={busy}
                  on:click={() => exclude(r, status !== "Excluded")}
                  >{status === "Excluded"
                    ? "Include in sync"
                    : "Exclude from sync"}</button
                >{/if}
              {#if r.row.asin}<a
                  href={`https://www.amazon.co.uk/dp/${r.row.asin}`}
                  target="_blank"
                  rel="noreferrer">View on Amazon</a
                >{/if}
            </div>
            {#if editKey === r.row.key}<section class="resolve">
                <h3>Resolve {r.row.title} {r.row.subtype}</h3>
                <p>{statusDetail(r, now)}</p>

                <div class="actions">
                  <label
                    >GBP price<input
                      type="number"
                      min="0.01"
                      step="0.01"
                      bind:value={price}
                    /></label
                  ><label
                    >Amazon product type<input
                      bind:value={productType}
                      list="amazon-type-options"
                      placeholder="Choose a suggested type"
                    /></label
                  ><button disabled={busy} on:click={() => discover(r)}
                    >Suggest product types</button
                  >
                </div>
                <datalist id="amazon-type-options"
                  >{#each suggestions as suggestion}<option
                      value={suggestion.name}>{suggestion.displayName}</option
                    >{/each}</datalist
                >{#if suggestions.length}<p>
                    Amazon suggestions: {#each suggestions as suggestion}<button
                        on:click={() => (productType = suggestion.name)}
                        >{suggestion.displayName || suggestion.name}</button
                      >{/each}
                  </p>{/if}
                {#if !r.row.asin}
                  <h4>Existing Amazon product: add your offer</h4>
                  <p>
                    Confirm the product, colour and pack size match exactly.
                    This adds your offer without replacing Amazon product
                    content.
                  </p>
                  <button
                    disabled={busy || r.row.onHand <= 0}
                    on:click={() => findMatches([r])}>Find ASIN matches</button
                  >
                  {#if r.offerMatch?.error}<p role="alert">
                      {r.offerMatch.error}
                    </p>{/if}
                  {#if r.offerMatch?.checked && !r.offerMatch.error && !r.offerMatch.candidates.length}<p
                    >
                      No matching ASINs returned for this barcode. Enter an
                      independently verified ASIN or prepare a new product
                      listing.
                    </p>{/if}
                  {#each r.offerMatch?.candidates || [] as candidate}<div>
                      <a
                        href={`https://www.amazon.co.uk/dp/${candidate.asin}`}
                        target="_blank"
                        rel="noreferrer">{candidate.title} — {candidate.asin}</a
                      >
                      <p>{candidate.brand}</p>
                      <button
                        on:click={() => {
                          asin = candidate.asin;
                          asinVerified = false;
                        }}>Use this ASIN</button
                      >
                    </div>{/each}
                  <label
                    >Existing ASIN<input
                      value={asin}
                      on:input={(e) => {
                        asin = e.currentTarget.value;
                        asinVerified = false;
                      }}
                      maxlength="10"
                      placeholder="B012345678"
                    /></label
                  >
                  <label class="inline"
                    ><input type="checkbox" bind:checked={asinVerified} />I
                    verified this ASIN matches the exact product, variant and
                    pack size.</label
                  >
                {/if}<label
                  >Verified existing Amazon seller SKU<input
                    bind:value={sku}
                    placeholder="Leave blank for a new listing"
                    maxlength="200"
                  /></label
                >{#if r.row.skuCandidates.length}<p>
                    Barcode matches: {r.row.skuCandidates.join(", ")}. Confirm
                    the exact variant before linking.
                  </p>{/if}<button disabled={busy} on:click={() => save(r)}
                  >Save choices</button
                ><button on:click={() => (editKey = "")}>Cancel</button>
              </section>{/if}
          </article>{/each}
      {/if}
    </details>{/each}
</main>

<style>
  .family-variants {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 1rem;
  }
  .family-variants th,
  .family-variants td {
    text-align: left;
    padding: 0.6rem;
    border-bottom: 1px solid #ddd;
  }
  .offer-comparison {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1rem;
    margin: 1rem 0;
  }
  .offer-comparison > div {
    min-width: 0;
    background: white;
    padding: 0.5rem;
    border-radius: 0.5rem;
    overflow-wrap: anywhere;
  }
  .offer-comparison p {
    margin: 0.5rem 0;
  }
  .missing-photo {
    height: 180px;
    display: grid;
    place-items: center;
    background: #f1f5f9;
    color: #475569;
    text-align: center;
  }

  main {
    max-width: 1500px;
    margin: auto;
    padding: 1.5rem;
    color: #1f2937;
  }
  header,
  .toolbar,
  .actions,
  .rowhead,
  .values {
    display: flex;
    gap: 1rem;
    align-items: center;
    flex-wrap: wrap;
  }
  header,
  .rowhead {
    justify-content: space-between;
  }
  h1 {
    margin: 0;
  }
  p {
    line-height: 1.5;
  }
  button,
  input,
  select {
    font: inherit;
    padding: 0.6rem 0.8rem;
    border: 1px solid #94a3b8;
    border-radius: 0.4rem;
    background: white;
    color: #1f2937;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .primary,
  .cards .current {
    background: #1e40af;
    color: white;
    border-color: #1e40af;
  }
  button:focus-visible,
  a:focus-visible {
    outline: 3px solid #f59e0b;
    outline-offset: 3px;
  }
  .status,
  .toolbar,
  .settings,
  .review {
    padding: 1rem;
    background: #f1f5f9;
    border: 1px solid #cbd5e1;
    border-radius: 0.6rem;
    margin: 1rem 0;
  }
  .status span {
    margin-left: 1rem;
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.6rem;
  }
  .cards button {
    text-align: left;
    min-height: 85px;
  }
  .cards strong {
    display: block;
    font-size: 1.6rem;
    margin-bottom: 0.3rem;
  }
  .muted,
  small,
  .values {
    color: #475569;
    font-size: 0.875rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .inline {
    flex-direction: row;
    align-items: center;
  }
  .toolbar {
    align-items: end;
  }
  .family {
    border: 1px solid #cbd5e1;
    border-radius: 0.6rem;
    margin: 0.7rem 0;
  }
  summary {
    padding: 1rem;
    cursor: pointer;
  }
  summary span {
    display: block;
    margin: 0.4rem 0 0 1rem;
    color: #475569;
  }
  article {
    padding: 1rem;
    border-top: 1px solid #e2e8f0;
  }
  .actions {
    margin: 1rem 0;
  }
  .resolve,
  .review {
    background: #eff6ff;
    padding: 1rem;
    border: 1px solid #93c5fd;
  }
  .error,
  .failed {
    color: #991b1b;
  }
  .error {
    padding: 0.8rem;
    background: #fef2f2;
  }
  input[type="checkbox"] {
    width: 18px;
    height: 18px;
  }
  a {
    color: #1e40af;
  }
  input,
  select {
    max-width: 100%;
  }
  @media (max-width: 640px) {
    main {
      padding: 0.8rem;
    }
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .toolbar > label,
    .toolbar > button {
      width: 100%;
    }
    .status span {
      display: block;
      margin: 0.5rem 0;
    }
  }
</style>
