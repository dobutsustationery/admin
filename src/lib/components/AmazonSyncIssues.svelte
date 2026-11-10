<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    collection,
    doc,
    writeBatch,
    runTransaction,
    serverTimestamp,
    onSnapshot,
    query,
    where,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store, initialSyncReady } from "$lib/store";
  import { user } from "$lib/user-store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
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
    const items = await legacyImageBaselines($store);
    if (!items.length) {
      return;
    }
    const ref = doc(
      firestore,
      "broadcast",
      `amazon-image-baseline-v1-${seller}`,
    );
    await runTransaction(firestore, async (tx) => {
      if ((await tx.get(ref)).exists()) return;
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
    });
  }
  $: allRows = projectAmazonSync($store);
  $: rows = allRows.filter((r) =>
    `${r.title} ${r.handle} ${r.details.map((d) => d.key + " " + d.sku).join(" ")}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  $: rate = amazonExchangeRate($store.amazonPreparation, seller);
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

<section class="sync-issues" aria-label="Amifa Amazon sync issues">
  <h2>Amifa sync issues</h2>
  <p>
    One row per listing. Sync listing applies all supported differences
    together, including stock, price, product details, images and relationships.
    Amazon approvals and Featured Offer decisions remain visible when they need
    attention. Price: EUR × {rate} → GBP.
  </p>
  <p>
    <a href="/amazon-categories">Amazon category mappings and exchange rate</a>
    · {allRows.length} stocked or existing Amifa listings
  </p>
  <label
    >Search listings <input
      type="search"
      bind:value={search}
      placeholder="Title, JAN or SKU"
    /></label
  >
  {#if !seller}<p>Refresh from Amazon to load your UK seller catalogue.</p>{/if}
  {#if message}<p role="status" class="message">{message}</p>{/if}
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
    {#each issueEntries as [issue, label]}
      {@const affected = rows.filter((r) => r.issues.includes(issue))}
      {@const eligible = affected.filter(
        (r) => r.entries.all?.length && !submitted[pendingKey(r.handle, "all")],
      )}
      <details data-issue={issue}>
        <summary
          ><strong>{label}</strong><span>{affected.length} listing(s)</span
          ></summary
        >
        {#if !["attention", "processing", "synced", "category"].includes(issue) || eligible.length}
          <button
            class="primary"
            disabled={busy || !eligible.length}
            on:click={() => sync(eligible, "all")}
            >Sync listings in {label.toLowerCase()} ({eligible.length})</button
          >
        {/if}
        {#if issue === "category"}<p>
            <a href="/amazon-categories"
              >Set Shopify → Amazon category mappings</a
            >
          </p>{/if}
        {#if issue === "presence"}<p>
            Creates Amifa products with the mapped product type, current stock,
            converted price and existing catalogue defaults. Shared JAN variants
            use the approved Amifa GTIN exemption.
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
        {#if !affected.length}<p>No listings in this category.</p>{/if}
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
              <div><strong>{row.title}</strong><small>{row.handle}</small></div>
              {#if row.entries.all?.length}<button
                  disabled={busy || !!submitted[pendingKey(row.handle, "all")]}
                  on:click={() => sync([row], "all")}>Sync listing</button
                >{/if}
            </div>
            {#each row.details.filter((d) => d.issue === issue) as d}
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
                    Not yet published on Amazon.
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
