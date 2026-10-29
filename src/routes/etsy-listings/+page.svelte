<script lang="ts">
  import { onDestroy } from "svelte";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    etsyComparison,
    etsyIssueLabels,
    etsySyncEntry,
    type EtsyIssue,
    type EtsyListing,
    type EtsyRow,
  } from "$lib/etsy-listings";
  import {
    addDoc,
    collection,
    doc,
    limit,
    onSnapshot,
    orderBy,
    query as firestoreQuery,
    serverTimestamp,
    setDoc,
  } from "firebase/firestore";

  let listings: EtsyListing[] = [],
    mappings: Record<string, string> = {},
    mappingDrafts: Record<string, string> = {};
  let meta: any = {},
    results: any[] = [],
    error = "",
    message = "",
    busy = false;
  let search = "",
    filter: EtsyIssue | "all" = "quantity",
    selected = new Set<string>();
  let review: { field: string; rows: EtsyRow[]; entries: any[] } | null = null;
  let account = "",
    subscriptions: (() => void)[] = [];
  const categories = Object.keys(etsyIssueLabels) as EtsyIssue[];
  function stop() {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    subscriptions = [];
  }
  function listen(uid: string) {
    stop();
    account = uid;
    if (!uid) return;
    const fail = (e: any) => {
      error = e.message;
    };
    subscriptions = [
      onSnapshot(
        collection(firestore, "etsy_listing_catalog"),
        (snapshot) => {
          listings = snapshot.docs.map((d) => d.data() as EtsyListing);
        },
        fail,
      ),
      onSnapshot(
        doc(firestore, "etsy_listing_sync", "state"),
        (snapshot) => {
          meta = snapshot.data() || {};
        },
        fail,
      ),
      onSnapshot(
        collection(firestore, "etsy_listing_mappings"),
        (snapshot) => {
          mappings = Object.fromEntries(
            snapshot.docs.map((d) => [d.id, d.data().itemKey]),
          );
        },
        fail,
      ),
      onSnapshot(
        firestoreQuery(
          collection(firestore, "etsy_listing_results"),
          orderBy("startedAtMs", "desc"),
          limit(10),
        ),
        (snapshot) => {
          results = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        },
        fail,
      ),
    ];
  }
  $: if (($user?.uid || "") !== account) listen($user?.uid || "");
  onDestroy(stop);
  $: observed = meta.listingIds
    ? listings.filter((l) => meta.listingIds.includes(l.listingId))
    : listings;
  $: rows = etsyComparison($store, observed, mappings);
  $: counts = Object.fromEntries(
    categories.map((c) => [c, rows.filter((r) => r.issues.includes(c)).length]),
  );
  $: visible = rows.filter(
    (r) =>
      (filter === "all" || r.issues.includes(filter)) &&
      `${r.title} ${r.matches.map((m) => `${m.sku} ${m.label} ${m.itemKey}`).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  $: filterLabel = filter === "all" ? "All" : etsyIssueLabels[filter];
  $: inProgress = results.filter((r) => r.status === "running");
  $: inventoryChoices = Object.entries($store.inventory.idToItem).map(
    ([key, item]: [string, any]) => ({
      key,
      label: `${item.description || ""} ${item.subtype || ""}`,
    }),
  );
  const canSync = (field: string) =>
    ["quantity", "price", "title", "description"].includes(field);
  function toggle(key: string, checked: boolean) {
    const next = new Set(selected);
    checked ? next.add(key) : next.delete(key);
    selected = next;
  }
  async function refresh() {
    if (!$user?.uid || busy) return;
    busy = true;
    error = "";
    try {
      await addDoc(collection(firestore, "request_etsy_listings"), {
        creator: $user.uid,
        mode: "refresh",
        createdAt: serverTimestamp(),
      });
      message =
        "Etsy refresh queued. Progress is saved; you can leave this page.";
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function prepare(field: string, candidates: EtsyRow[]) {
    const eligible = candidates
      .map((row) => ({ row, entry: etsySyncEntry(row, field) }))
      .filter((x) => x.entry)
      .slice(0, 100);
    review = eligible.length
      ? {
          field,
          rows: eligible.map((x) => x.row),
          entries: eligible.map((x) => x.entry),
        }
      : null;
    if (!review)
      message =
        "No eligible changes in these listings. Expand a listing to review unmatched variations or currency differences.";
  }
  async function publish() {
    if (!review || !$user?.uid || busy || meta.canWrite === false) return;
    busy = true;
    error = "";
    try {
      // Recheck local values immediately before recording the requested change.
      const current = review.rows
        .map((r) => rows.find((x) => x.key === r.key))
        .map((r) => (r ? etsySyncEntry(r, review!.field) : null));
      if (JSON.stringify(current) !== JSON.stringify(review.entries))
        throw Error(
          "Local values changed. Close this review and prepare it again.",
        );
      await addDoc(collection(firestore, "request_etsy_listings"), {
        creator: $user.uid,
        mode: "sync",
        field: review.field,
        entries: review.entries,
        createdAt: serverTimestamp(),
      });
      message = `Queued ${review.field} updates for ${review.entries.length} Etsy listings. Results appear below.`;
      review = null;
      selected = new Set();
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  async function saveMatch(id: string) {
    if (!$user?.uid) return;
    const itemKey = (mappingDrafts[id] || "").trim();
    if (!$store.inventory.idToItem[itemKey]) {
      error = "Choose an existing inventory item key.";
      return;
    }
    try {
      await setDoc(doc(firestore, "etsy_listing_mappings", id), {
        itemKey,
        creator: $user.uid,
        updatedAtMs: Date.now(),
      });
    } catch (e: any) {
      error = e.message;
    }
  }
</script>

<svelte:head><title>Etsy listings — Dobutsu Admin</title></svelte:head>
<main>
  <header>
    <div>
      <h1>Etsy listings</h1>
      <p>
        Compare Etsy with local inventory and listings. Sync one category at a
        time.
      </p>
    </div>
    <button
      disabled={busy ||
        !$user?.uid ||
        inProgress.some((r) => r.mode === "refresh")}
      on:click={refresh}>Refresh from Etsy</button
    >
  </header>
  <p>
    {observed.length} Etsy listings · Shop currency {meta.currency ||
      "not loaded"} · Local prices EUR · {meta.completedAtMs
      ? `Last full refresh ${new Date(meta.completedAtMs).toLocaleString()}`
      : "No full refresh completed yet"}
  </p>
  <p>
    Quantity sync changes stock only. Price sync preserves stock. Title and
    description edits are reviewed separately. Photos and listing activation are
    managed on Etsy.
  </p>
  {#if meta.canWrite === false}<p role="status">
      Etsy is connected for reading only. Reconnect Etsy with permission to edit
      listings before submitting changes. You can still review all mismatches.
    </p>{/if}
  {#if error || meta.error}<p class="error" role="alert">
      {error || meta.error}
    </p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#each inProgress as result}<p role="status">
      {result.mode === "refresh"
        ? "Reading Etsy listings"
        : "Syncing Etsy listings"}: {result.completed || 0}{result.total
        ? ` / ${result.total}`
        : ""}. You can leave and return.
    </p>{/each}
  <div class="filters">
    <button class:active={filter === "all"} on:click={() => (filter = "all")}
      >All ({rows.length})</button
    >{#each categories as c}<button
        class:active={filter === c}
        on:click={() => (filter = c)}
        >{etsyIssueLabels[c]} ({counts[c] || 0})</button
      >{/each}
  </div>
  <label>Search listing or SKU<input type="search" bind:value={search} /></label
  >
  <div class="actions">
    <button on:click={() => (selected = new Set(visible.map((r) => r.key)))}
      >Select visible</button
    ><button on:click={() => (selected = new Set())}>Clear selection</button
    >{#if canSync(filter)}<button
        disabled={busy || !visible.some((r) => etsySyncEntry(r, filter))}
        on:click={() => prepare(filter, visible)}
        >Review {filterLabel.toLowerCase()} changes in this category</button
      ><button
        disabled={busy || !selected.size}
        on:click={() =>
          prepare(
            filter,
            visible.filter((r) => selected.has(r.key)),
          )}>Review selected</button
      >{/if}
  </div>
  {#if filter === "presence"}<p>
      These stocked local listings have no matched Etsy variations. Some may
      already exist with different or missing SKUs. Resolve the match before
      creating anything; this page does not create Etsy listings.
    </p>{/if}
  {#if filter === "state"}<p>
      These listings are not active but have matched stock. Review and activate
      on Etsy when appropriate; activation can incur a renewal fee.
    </p>{/if}
  {#if review}<section class="review" aria-label="Review Etsy changes">
      <h2>Review {review.field} changes</h2>
      <p>
        {review.entries.length} listings. Only {review.field} will change. Other fields
        and photos are preserved.
      </p>
      {#each review.rows as row, index}<h3>{row.title}</h3>
        {#if review.entries[index].targets}<ul>
            {#each review.entries[index].targets as target}<li>
                {target.sku || target.itemKey}: {review.field === "quantity"
                  ? target.beforeQuantity
                  : target.beforePrice} → {target.value}{review.field ===
                "price"
                  ? " EUR"
                  : ""}
              </li>{/each}
          </ul>{:else}<div class="comparison">
            <div>
              <strong>On Etsy</strong>
              <pre>{review.entries[index].before}</pre>
            </div>
            <div>
              <strong>Proposed</strong>
              <pre>{review.entries[index].value}</pre>
            </div>
          </div>{/if}{/each}
      <button
        disabled={busy ||
          meta.canWrite === false ||
          inProgress.some((r) => r.mode === "sync")}
        on:click={publish}>Sync reviewed {review.field} changes to Etsy</button
      ><button on:click={() => (review = null)}>Cancel</button>
    </section>{/if}
  <p>{visible.length} listings shown. Category counts overlap.</p>
  <table>
    <thead
      ><tr
        ><th>Select</th><th>Listing</th><th>Photos</th><th>Differences</th><th
          >Details</th
        ></tr
      ></thead
    ><tbody>
      {#each visible as row (row.key)}<tr
          ><td
            ><input
              type="checkbox"
              aria-label={`Select ${row.title}`}
              checked={selected.has(row.key)}
              on:change={(e) => toggle(row.key, e.currentTarget.checked)}
            /></td
          ><td
            ><strong>{row.title}</strong>{#if row.remote}<small
                >Etsy {row.remote.listingId} · {row.remote.state}</small
              ><a href={row.remote.url} target="_blank" rel="noreferrer"
                >View on Etsy</a
              >{/if}{#each row.handles as handle}<small
                ><a
                  href={`/listing-detail?handle=${encodeURIComponent(handle)}`}
                  >Local listing</a
                ></small
              >{/each}</td
          ><td
            ><div class="thumbnails">
              {#each (row.remote?.images || []).slice(0, 4) as image}<ImageThumbnail
                  src={image.url}
                  alt={row.title}
                  width="52px"
                  height="52px"
                  fit="contain"
                />{/each}
            </div></td
          ><td>{row.issues.map((i) => etsyIssueLabels[i]).join(", ")}</td><td
            ><details>
              <summary>Compare {row.matches.length} variations</summary>
              {#if row.remote?.inventoryError}<p class="error">
                  {row.remote.inventoryError}
                </p>{/if}
              {#if row.matches.length}<table class="variants">
                  <thead
                    ><tr
                      ><th>Etsy variant / SKU</th><th>Local item</th><th
                        >Stock Etsy → local</th
                      ><th>Price Etsy → local</th><th>Match</th></tr
                    ></thead
                  ><tbody
                    >{#each row.matches as match}<tr
                        ><td
                          >{match.label}<small>{match.sku || "No SKU"}</small
                          ></td
                        ><td
                          >{match.item?.description || "Unmatched"}<small
                            >{match.itemKey}</small
                          >{#if match.item?.image}<ImageThumbnail
                              src={match.item.image}
                              alt={match.label}
                              width="52px"
                              height="52px"
                              fit="contain"
                            />{/if}</td
                        ><td
                          >{match.quantity} → {match.itemKey
                            ? match.wantedQuantity
                            : "?"}</td
                        ><td
                          >{match.price.toFixed(2)}
                          {row.remote?.currency} → {match.itemKey
                            ? match.wantedPrice.toFixed(2)
                            : "?"} EUR</td
                        ><td
                          >{#if match.error}<span class="error"
                              >{match.error}</span
                            >{/if}{#if match.excluded}<small
                              >Local listing is No Sync</small
                            >{/if}<label
                            >Inventory item key<input
                              list="etsy-local-items"
                              placeholder={match.itemKey || "JAN + subtype"}
                              bind:value={
                                mappingDrafts[`${row.key}-${match.productId}`]
                              }
                            /></label
                          ><button
                            on:click={() =>
                              saveMatch(`${row.key}-${match.productId}`)}
                            >Save match</button
                          ></td
                        ></tr
                      >{/each}</tbody
                  >
                </table>{/if}
              {#if row.handles.length > 1}<p>
                  This Etsy listing combines several local listings. Quantities
                  and prices can sync per variation; no single local title or
                  description is proposed.
                </p>{/if}
              {#if row.remote?.currency && row.remote.currency !== "EUR"}<p
                  class="error"
                >
                  Price sync is unavailable: Etsy uses {row.remote.currency},
                  local prices are EUR.
                </p>{/if}
              {#each ["quantity", "price", "title", "description"] as field}{#if etsySyncEntry(row, field)}<button
                    disabled={busy}
                    on:click={() => prepare(field, [row])}
                    >Review {field} change</button
                  >{/if}{/each}
              {#if row.localTitle && row.remote}<div class="comparison">
                  <div>
                    <h4>Etsy title</h4>
                    <p>{row.remote.title}</p>
                    <h4>Etsy description</h4>
                    <pre>{row.remote.description}</pre>
                  </div>
                  <div>
                    <h4>Local title</h4>
                    <p>{row.localTitle}</p>
                    {#if row.localTitle.length > 140}<p class="error">
                        Local title exceeds Etsy's 140-character limit. Shorten
                        it before syncing.
                      </p>{/if}
                    <h4>Local description</h4>
                    <pre>{row.localDescription}</pre>
                  </div>
                </div>{/if}
            </details></td
          ></tr
        >{/each}
    </tbody>
  </table>
  {#if !visible.length}<p>
      No listings in this category. Refresh from Etsy to check current values.
    </p>{/if}
  <datalist id="etsy-local-items"
    >{#each inventoryChoices as item}<option value={item.key}
        >{item.label}</option
      >{/each}</datalist
  >
  <section>
    <h2>Recent requests</h2>
    {#each results as result}<details>
        <summary
          >{result.mode} · {result.status} · {new Date(
            result.startedAtMs,
          ).toLocaleString()} · {result.completed || 0}{result.total
            ? ` / ${result.total}`
            : ""}</summary
        >{#if result.error}<p class="error">
            {result.error}
          </p>{/if}{#each result.results || [] as entry}<p>
            Etsy {entry.listingId}: {entry.success ? "Verified" : entry.error}
          </p>{/each}
      </details>{/each}
  </section>
</main>

<style>
  main {
    padding: 1.5rem;
    max-width: 1600px;
    margin: auto;
  }
  header,
  .filters,
  .actions,
  .thumbnails {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
  }
  header {
    justify-content: space-between;
  }
  .filters,
  .actions {
    margin: 1rem 0;
  }
  button {
    padding: 0.45rem 0.7rem;
    cursor: pointer;
  }
  button.active {
    background: #243c33;
    color: white;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  input {
    padding: 0.4rem;
    max-width: 100%;
  }
  table {
    border-collapse: collapse;
    width: 100%;
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid #ddd;
    padding: 0.7rem;
  }
  small {
    display: block;
    color: #666;
    margin: 0.25rem 0;
  }
  .error {
    color: #a12727;
  }
  .review {
    padding: 1rem;
    border: 2px solid #547463;
    margin: 1rem 0;
    background: #f5faf7;
  }
  .comparison {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    max-height: 18rem;
    overflow-y: auto;
  }
  .variants {
    min-width: 600px;
  }
  details {
    max-width: 100%;
    overflow-x: auto;
  }
  section {
    margin: 1.5rem 0;
  }
  @media (max-width: 800px) {
    main {
      padding: 0.5rem;
      overflow-x: auto;
    }
    .comparison {
      grid-template-columns: 1fr;
    }
  }
</style>
