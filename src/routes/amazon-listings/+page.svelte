<script lang="ts">
  import { onDestroy } from "svelte";
  import {
    addDoc,
    collection,
    onSnapshot,
    serverTimestamp,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import AmazonDiagnostics from "$lib/components/AmazonDiagnostics.svelte";
  import {
    AMAZON_AUDIT_REQUEST_COLLECTION,
    UK_MARKETPLACE,
    initialAmazonAudit,
    type AuditRow,
    type AmazonAuditState,
  } from "$lib/amazon-audit";
  let query = "",
    filter = "All",
    message = "",
    error = "";
  let busy = false,
    diagnostics = false,
    focusItemKey = "";
  let selected = new Set<string>();
  let mappingDrafts: Record<string, string> = {};
  let unsubscribe = () => {};
  onDestroy(() => unsubscribe());
  $: audit = ($store.amazonAudit || initialAmazonAudit) as AmazonAuditState;
  $: rows = audit.rows;
  $: visible = rows.filter(
    (r: AuditRow) =>
      (filter === "All" ||
        (filter === "Shared JAN" ? r.sharedJan : r.health === filter)) &&
      query
        .toLowerCase()
        .split(/\s+/)
        .every((t) =>
          [r.title, r.jan, r.subtype, r.key, r.sku, r.asin]
            .join(" ")
            .toLowerCase()
            .includes(t),
        ),
  );
  $: families = [...new Set(visible.map((r: AuditRow) => r.family))];
  $: selectedRows = rows.filter((r: AuditRow) => selected.has(r.key));
  $: latest = Object.values(audit.runs)
    .filter(
      (r) =>
        r.mode === "catalogue" &&
        r.sellerId === audit.sellerId &&
        r.marketplaceId === UK_MARKETPLACE,
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  $: waiting = Object.values(audit.runs).filter(
    (r) =>
      r.status === "waiting" &&
      r.sellerId === audit.sellerId &&
      r.marketplaceId === UK_MARKETPLACE &&
      r.mode !== "catalogue",
  ).length;
  const date = (at: number) => (at ? new Date(at).toLocaleString() : "Never");
  function toggle(key: string) {
    selected = new Set(selected);
    selected.has(key) ? selected.delete(key) : selected.add(key);
  }
  async function request(mode: "catalogue" | "selected") {
    if (!$user?.uid) {
      error = "Sign in to refresh Amazon.";
      return;
    }
    const skus: string[] =
      mode === "selected"
        ? [...new Set(selectedRows.map((r: AuditRow) => r.sku).filter(Boolean))]
        : [];
    if (mode === "selected" && (!skus.length || skus.length > 100)) {
      error = "Select between 1 and 100 linked seller SKUs.";
      return;
    }
    busy = true;
    error = "";
    message = "";
    unsubscribe();
    try {
      const ref = await addDoc(
        collection(firestore, AMAZON_AUDIT_REQUEST_COLLECTION),
        {
          creator: $user.uid,
          marketplaceId: UK_MARKETPLACE,
          mode,
          skus,
          createdAt: serverTimestamp(),
        },
      );
      message =
        "Refresh requested. Waiting for the Amazon worker; you can leave this page.";
      unsubscribe = onSnapshot(
        ref,
        (snapshot) => {
          if (snapshot.data()?.error) {
            error = snapshot.data()?.error;
            message = "";
          } else if (snapshot.data()?.queuedAt)
            message =
              "Refresh queued on the server. Results and processing checks appear automatically.";
        },
        (e) => (error = e.message),
      );
    } catch (e: any) {
      error = e.message || "Could not queue the audit.";
    } finally {
      busy = false;
    }
  }
  async function saveMapping(row: AuditRow) {
    if (!$user?.uid || !audit.sellerId) return;
    const sku = String(mappingDrafts[row.key] ?? row.sku).trim();
    if (sku.length > 200) {
      error = "SKU must be at most 200 characters.";
      return;
    }
    busy = true;
    error = "";
    try {
      await addDoc(collection(firestore, "broadcast"), {
        type: "amazonAudit/map",
        payload: {
          sellerId: audit.sellerId,
          marketplaceId: UK_MARKETPLACE,
          itemKey: row.key,
          sku,
        },
        creator: $user.uid,
        timestamp: serverTimestamp(),
      });
      message = sku
        ? "SKU mapping saved. Select the row and refresh to verify it."
        : "Saved mapping removed.";
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function inspect(row: AuditRow) {
    focusItemKey = row.key;
    diagnostics = true;
  }
</script>

<svelte:head><title>Amazon · Amifa catalogue</title></svelte:head>
<main>
  <header>
    <div>
      <h1>Amazon · Amifa catalogue</h1>
      <p>UK marketplace · GBP · Merchant fulfilled</p>
    </div>
    <button
      disabled={busy ||
        !$store.inventory.initialized ||
        latest?.status === "waiting"}
      on:click={() => request("catalogue")}>Refresh seller catalogue</button
    >
  </header>
  <p>
    Review your Amifa products, link existing Amazon SKUs, and resolve listing
    issues. Refreshing reads Amazon; it does not publish products or change
    stock.
  </p>
  <section class="summary" aria-label="Catalogue summary">
    <div><strong>{rows.length}</strong> local variants</div>
    <div>
      <strong>{rows.filter((r) => r.health === "Active").length}</strong> active offers
    </div>
    <div>
      <strong
        >{rows.filter((r) => r.health === "Needs attention").length}</strong
      > need attention
    </div>
    <div><strong>{waiting}</strong> automatic checks pending</div>
  </section>
  {#if latest}<p class="coverage">
      Seller {audit.sellerId} · Audit started {date(latest.startedAt)} · {latest.pages}
      pages / {latest.count} seller listings read ·
      <strong
        >{latest.status === "complete"
          ? "All search pages read"
          : latest.status === "waiting"
            ? "Audit in progress; coverage is incomplete"
            : `Coverage incomplete (${latest.status})`}</strong
      >. {latest.error || ""}
    </p>{:else}<p class="coverage">
      No full seller audit recorded. Products are identified as Amifa by their
      existing name or brand; unnamed products may need their local description
      corrected.
    </p>{/if}
  <p class="coverage">
    Statuses describe the last observation, not guaranteed current stock. Unseen
    SKUs are never assumed deleted. GBP prices below come from Amazon; local EUR
    prices are not converted or published.
  </p>
  {#if message}<p role="status">{message}</p>{/if}
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  <div class="toolbar">
    <label
      >Find products <input
        type="search"
        bind:value={query}
        placeholder="Name, JAN, variant, SKU or ASIN"
      /></label
    >
    <label
      >Status <select bind:value={filter}
        >{#each ["All", "Active", "Processing", "Needs attention", "No offer", "Not linked", "Not checked", "Shared JAN"] as value}<option
            >{value}</option
          >{/each}</select
      ></label
    >
    <button on:click={() => (selected = new Set(visible.map((r) => r.key)))}
      >Select filtered</button
    >
    <button on:click={() => (selected = new Set())}>Clear selection</button>
    <button
      disabled={busy || !selectedRows.some((r) => r.sku)}
      on:click={() => request("selected")}>Refresh selected SKUs</button
    >
    <span
      >{selectedRows.length} selected · {selectedRows.filter((r) => !r.sku)
        .length} unlinked (excluded from refresh)</span
    >
  </div>
  {#if !$store.inventory.initialized}<p>
      Loading inventory…
    </p>{:else if !visible.length}<p>No products match this filter.</p>{/if}
  {#each families as family}
    {@const members = visible.filter((r) => r.family === family)}
    <details
      class="family"
      open={!!query || members.some((r) => r.health === "Needs attention")}
    >
      <summary
        ><strong>{members[0].title}</strong><span
          >{members.length} variant{members.length === 1 ? "" : "s"} · {members.filter(
            (r) => r.health === "Active",
          ).length} active{members.some((r) => r.sharedJan)
            ? " · Shared JAN"
            : ""}</span
        ></summary
      >
      <div class="table-scroll">
        <table>
          <thead
            ><tr
              ><th>Select</th><th>Variant</th><th>Local stock</th><th
                >Amazon offer</th
              ><th>Status / next step</th><th>Seller SKU mapping</th></tr
            ></thead
          ><tbody>
            {#each members as row}<tr>
                <td
                  ><input
                    type="checkbox"
                    aria-label={`Select ${row.key}`}
                    checked={selected.has(row.key)}
                    on:change={() => toggle(row.key)}
                  /></td
                >
                <td
                  >{row.subtype || "Default"}<small>{row.jan}</small
                  >{#if row.asin}<a
                      href={`https://www.amazon.co.uk/dp/${encodeURIComponent(row.asin)}`}
                      target="_blank"
                      rel="noreferrer">{row.asin}</a
                    >{/if}</td
                >
                <td>{row.onHand}</td><td
                  >{row.price}<small
                    >{row.quantity === null
                      ? "Quantity not observed"
                      : `${row.quantity} available on Amazon`}</small
                  ></td
                >
                <td
                  ><strong class:active={row.health === "Active"}
                    >{row.health}</strong
                  >
                  <p>{row.detail}</p>
                  <small>Checked: {date(row.checkedAt)}</small><button
                    on:click={() => inspect(row)}>Open diagnostics</button
                  ></td
                >
                <td
                  ><label
                    >Seller SKU <input
                      value={mappingDrafts[row.key] ?? row.sku}
                      on:input={(e) =>
                        (mappingDrafts = {
                          ...mappingDrafts,
                          [row.key]: e.currentTarget.value,
                        })}
                      placeholder="Existing Amazon seller SKU"
                    /></label
                  ><small>{row.mappingSource || "No mapping saved"}</small
                  >{#if row.skuCandidates.length}<small
                      >JAN matches (verify variant): {row.skuCandidates.join(
                        ", ",
                      )}</small
                    >{/if}<button
                    disabled={busy || !audit.sellerId}
                    on:click={() => saveMapping(row)}>Save mapping</button
                  ></td
                >
              </tr>{/each}
          </tbody>
        </table>
      </div>
    </details>
  {/each}
  <details class="diagnostics" bind:open={diagnostics}>
    <summary>Diagnostics and advanced listing submission</summary
    >{#if diagnostics}<AmazonDiagnostics {focusItemKey} />{/if}
  </details>
</main>

<style>
  main {
    max-width: 1500px;
    margin: auto;
    padding: 1.5rem;
    color: #1f2937;
  }
  header,
  .toolbar,
  .summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
  }
  header {
    justify-content: space-between;
  }
  h1 {
    margin-bottom: 0.3rem;
  }
  p {
    line-height: 1.5;
  }
  .summary {
    margin: 1.5rem 0;
  }
  .summary div {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    padding: 0.8rem 1rem;
    border-radius: 0.5rem;
  }
  .summary strong {
    font-size: 1.3rem;
    margin-right: 0.4rem;
  }
  .coverage,
  small {
    color: #4b5563;
    font-size: 0.875rem;
  }
  small {
    display: block;
    margin: 0.4rem 0;
  }
  .toolbar {
    background: #f8fafc;
    padding: 1rem;
    margin: 1rem 0;
    border-radius: 0.5rem;
    align-items: end;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.875rem;
  }
  input,
  select,
  button {
    font: inherit;
    border: 1px solid #94a3b8;
    border-radius: 0.3rem;
    padding: 0.5rem 0.7rem;
    background: white;
    color: #1f2937;
  }
  input[type="search"] {
    min-width: 270px;
  }
  button {
    cursor: pointer;
  }
  button:hover:enabled {
    background: #eff6ff;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .family {
    margin-bottom: 0.7rem;
    border: 1px solid #cbd5e1;
    border-radius: 0.5rem;
  }
  summary {
    cursor: pointer;
    padding: 1rem;
  }
  summary span {
    margin-left: 1rem;
    color: #475569;
    font-size: 0.875rem;
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.8rem;
    border-top: 1px solid #e2e8f0;
    vertical-align: top;
  }
  th {
    background: #f8fafc;
  }
  td p {
    max-width: 28rem;
    margin: 0.4rem 0;
  }
  td input:not([type="checkbox"]) {
    width: 200px;
  }
  .active {
    color: #166534;
  }
  .error {
    color: #991b1b;
    background: #fef2f2;
    padding: 1rem;
  }
  .diagnostics {
    margin-top: 2rem;
    border-top: 1px solid #94a3b8;
  }
  @media (max-width: 640px) {
    main {
      padding: 0.7rem;
    }
    summary span {
      display: block;
      margin: 0.4rem 0 0;
    }
  }
</style>
