<script lang="ts">
  import { onDestroy, createEventDispatcher } from "svelte";
  import {
    addDoc,
    collection,
    onSnapshot,
    serverTimestamp,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { UK_MARKETPLACE } from "$lib/amazon-audit";
  import {
    initialPreparation,
    previewValid,
    preparationFingerprint,
    preparationScope,
    type PreparationRow,
    type PreparationDecision,
    type PreparationState,
  } from "$lib/amazon-preparation";
  const dispatch = createEventDispatcher();
  let active = false,
    busy = false,
    query = "",
    tab = "prepare",
    message = "",
    error = "",
    stockConfirmed = false;
  let reviewSignature = "";
  let factor = "",
    factorSeller = "";
  let drafts: Record<string, PreparationDecision> = {};
  let unchecked = new Set<string>();
  let unsubscribers: (() => void)[] = [];
  onDestroy(() => unsubscribers.forEach((u) => u()));
  $: prep = ($store.amazonPreparation ||
    initialPreparation) as PreparationState;
  $: seller = $store.amazonAudit?.sellerId || "";
  $: if (seller && factorSeller !== seller) {
    factorSeller = seller;
    factor = prep.policies[preparationScope(seller)]?.gbpPerEur || "";
  }
  $: inStock = prep.rows.filter((r) => r.row.onHand > 0);
  $: typeResponses = Object.values(
    $store.amazonCatalog?.rawResponsesById || {},
  ) as any[];
  function productTypes(
    r: PreparationRow,
    responses: any[],
  ): { name: string; displayName?: string }[] {
    const response = responses
      .filter(
        (v) =>
          v.kind === "product_type_search" &&
          v.key === r.row.title &&
          v.sellerId === seller &&
          v.marketplaceId === UK_MARKETPLACE,
      )
      .sort((a, b) => b.fetchedAtMs - a.fetchedAtMs)[0];
    return response?.raw?.productTypes || [];
  }
  async function discover(r: PreparationRow) {
    if (!$user?.uid) return;
    busy = true;
    error = "";
    try {
      await addDoc(
        collection(firestore, "request_amazon_product_type_discovery"),
        {
          eventType: "amazon/product_type_discovery_requested",
          creator: $user.uid,
          requestedBy: $user.uid,
          source: "amazon-preparation",
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
          createdAt: serverTimestamp(),
          timestamp: serverTimestamp(),
        },
      );
      message =
        "Looking up Amazon product types. Suggestions will appear beside this product when Amazon responds.";
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function sameEntry(r: PreparationRow) {
    return (
      r.entry &&
      preparationFingerprint(r.entry) === preparationFingerprint(r.job?.entry)
    );
  }
  function ready(
    r: PreparationRow,
    edits: Record<string, PreparationDecision>,
  ) {
    return (
      !!r.entry &&
      !edits[r.row.key] &&
      sameEntry(r) &&
      r.job?.status === "ready" &&
      previewValid(r.job)
    );
  }
  function pending(r: PreparationRow) {
    if (!sameEntry(r)) return false;
    if (
      ["queued", "publish_queued", "publishing", "readback_pending"].includes(
        r.job?.status,
      )
    )
      return true;
    if (["submitted", "unknown"].includes(r.job?.status))
      return (
        r.row.checkedAt <= (r.job.submittedAt || r.job.updatedAt) ||
        r.row.health === "Processing"
      );
    return false;
  }
  function blocked(r: PreparationRow) {
    return (
      (!!r.reason && r.reason !== "Price and stock already match Amazon.") ||
      (sameEntry(r) && r.job?.status === "blocked")
    );
  }
  $: readyRows = inStock.filter(
    (r) => ready(r, drafts) && !unchecked.has(r.row.key),
  );
  $: if (reviewSignature !== JSON.stringify(readyRows.map((r) => r.job.id))) {
    reviewSignature = JSON.stringify(readyRows.map((r) => r.job.id));
    stockConfirmed = false;
  }
  $: checkRows = inStock.filter(
    (r) =>
      r.entry &&
      !drafts[r.row.key] &&
      !pending(r) &&
      !ready(r, drafts) &&
      !unchecked.has(r.row.key),
  );
  $: issues = inStock.filter(blocked);
  $: shown = inStock.filter(
    (r) =>
      (tab === "issues"
        ? blocked(r)
        : tab === "review"
          ? ready(r, drafts) ||
            pending(r) ||
            ["submitted", "unknown"].includes(r.job?.status)
          : !r.decision.deferred) &&
      [r.row.title, r.row.jan, r.row.subtype, r.row.sku]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function event(type: string, payload: any) {
    if (!$user?.uid) throw Error("Sign in to save preparation choices.");
    await addDoc(collection(firestore, "broadcast"), {
      type,
      payload: { sellerId: seller, ...payload },
      creator: $user.uid,
      timestamp: serverTimestamp(),
    });
  }
  async function save(r: PreparationRow, changes = drafts[r.row.key] || {}) {
    busy = true;
    error = "";
    try {
      await event("amazonPrepare/decision", {
        itemKey: r.row.key,
        decision: changes,
      });
      const next = { ...drafts };
      delete next[r.row.key];
      drafts = next;
      stockConfirmed = false;
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function edit(r: PreparationRow, name: string, value: string) {
    drafts = {
      ...drafts,
      [r.row.key]: { ...drafts[r.row.key], [name]: value },
    };
    stockConfirmed = false;
  }
  async function savePolicy() {
    if (factor && !(Number(factor) > 0)) {
      error = "Enter a positive GBP-per-EUR factor.";
      return;
    }
    busy = true;
    error = "";
    try {
      await event("amazonPrepare/policy", { gbpPerEur: factor });
      stockConfirmed = false;
      message = "Pricing factor saved. Review the calculated GBP prices below.";
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  async function request(mode: "preview" | "publish") {
    if (!$user?.uid) {
      error = "Sign in to continue.";
      return;
    }
    const chosen = (mode === "preview" ? checkRows : readyRows).slice(0, 100);
    if (!chosen.length || (mode === "publish" && !stockConfirmed)) return;
    busy = true;
    error = "";
    try {
      const ref = await addDoc(
        collection(firestore, "request_amazon_prepare"),
        {
          creator: $user.uid,
          sellerId: seller,
          marketplaceId: UK_MARKETPLACE,
          mode,
          ...(mode === "preview"
            ? { entries: chosen.map((r) => r.entry) }
            : { jobIds: chosen.map((r) => r.job.id), stockConfirmed: true }),
          createdAt: serverTimestamp(),
        },
      );
      message =
        mode === "preview"
          ? `Checking ${chosen.length} products with Amazon. This does not publish them. You can leave and return.`
          : `Publishing requested for ${chosen.length} products. Other products are left for later; results appear below.`;
      unsubscribers.push(
        onSnapshot(
          ref,
          (s) => {
            if (s.data()?.error) error = s.data()?.error;
          },
          (e) => (error = e.message),
        ),
      );
      tab = "review";
      stockConfirmed = false;
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function select(key: string) {
    unchecked = new Set(unchecked);
    unchecked.has(key) ? unchecked.delete(key) : unchecked.add(key);
    stockConfirmed = false;
  }
  function status(r: PreparationRow) {
    if (drafts[r.row.key]) return "Save your changes before checking";
    if (
      r.job?.status === "submitted" &&
      r.row.checkedAt > (r.job.submittedAt || r.job.updatedAt)
    )
      return `After publication: ${r.row.health}. ${r.row.detail}`;
    if (r.job?.status === "unknown") return r.job.error;
    if (r.reason) return r.reason;
    if (!sameEntry(r)) return "Ready for Amazon check";
    return (
      (
        {
          queued: "Checking with Amazon…",
          ready: "Validated · ready to publish",
          blocked: r.job.error,
          publish_queued: "Queued for publication",
          publishing: "Sending / awaiting confirmation",
          readback_pending: "Accepted · scheduling readback",
          submitted: "Accepted · automatic readback in progress",
          unknown: r.job.error,
        } as Record<string, string>
      )[r.job.status] || "Ready for Amazon check"
    );
  }
</script>

<section class="preparation" aria-label="Prepare Amazon products">
  <div class="intro">
    <div>
      <h2>Get your Amifa products onto Amazon</h2>
      <p>
        Prepare products, check them with Amazon, then publish the ones that are
        ready. Products with issues can wait.
      </p>
    </div>
    <button
      class="primary"
      disabled={!seller || !$store.inventory.initialized}
      on:click={() => (active = !active)}
      >{active
        ? "Close preparation"
        : "Prepare Amifa products for Amazon"}</button
    >
  </div>
  {#if !seller}<p>Start by refreshing the seller catalogue below.</p>{/if}
  {#if active}
    <nav aria-label="Preparation steps">
      <button
        class:current={tab === "prepare"}
        on:click={() => (tab = "prepare")}
        >1. Prepare products ({inStock.length})</button
      >
      <button class:current={tab === "review"} on:click={() => (tab = "review")}
        >2. Review and publish ({readyRows.length} ready)</button
      >
      <button class:current={tab === "issues"} on:click={() => (tab = "issues")}
        >Needs attention / later ({issues.length})</button
      >
    </nav>
    <p>
      In-stock products are included by default. Uncheck products or choose
      “Later” to leave them out. Checks and publication run independently for
      each product.
    </p>
    {#if tab === "prepare"}
      <details>
        <summary>Set prices for products without an Amazon GBP price</summary>
        <p>
          Enter your chosen GBP price per EUR of local retail price. For
          example, 0.90 makes a €5 item £4.50. This is your pricing choice, not
          a live exchange rate. Existing Amazon prices and individual overrides
          take priority.
        </p>
        <div class="actions">
          <label
            >GBP per EUR <input
              type="number"
              min="0.001"
              step="0.001"
              bind:value={factor}
            /></label
          ><button disabled={busy} on:click={savePolicy}
            >Apply pricing factor</button
          >
        </div>
      </details>
    {/if}
    <div class="actions">
      <label
        >Filter preparation <input
          type="search"
          bind:value={query}
          placeholder="Product, barcode or variant"
        /></label
      >
      {#if tab !== "review"}<button
          class="primary"
          disabled={busy || !checkRows.length}
          on:click={() => request("preview")}
          >Check {Math.min(checkRows.length, 100)} products with Amazon</button
        >{/if}
      <span>{issues.length} products can be addressed later.</span>
    </div>
    {#if message}<p role="status">{message}</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if tab === "review"}
      <p>
        Review the exact price and stock below. Publishing updates only price
        and merchant-fulfilled stock for existing listings; new products are
        created individually. Validation may still be followed by delayed Amazon
        processing or further issues.
      </p>
      <label class="confirm"
        ><input type="checkbox" bind:checked={stockConfirmed} /> I have checked these
        quantities, including any recent Amazon sales not yet recorded here.</label
      >
      <button
        class="primary"
        disabled={busy || !readyRows.length || !stockConfirmed}
        on:click={() => request("publish")}
        >Publish {Math.min(readyRows.length, 100)} ready products · leave issues for
        later</button
      >
    {/if}
    <div class="table-wrap">
      <table>
        <thead
          ><tr
            ><th>Include</th><th>Product</th><th>GBP price</th><th
              >Stock to send</th
            ><th>Amazon product type</th><th>Next step</th></tr
          ></thead
        ><tbody>
          {#each shown as r (r.row.key)}
            <tr
              ><td
                ><input
                  type="checkbox"
                  aria-label={`Include ${r.row.key}`}
                  checked={!unchecked.has(r.row.key)}
                  on:change={() => select(r.row.key)}
                /></td
              >
              <td
                ><strong>{r.row.title}</strong><small
                  >{r.row.subtype} · {r.row.jan}</small
                ><small
                  >{r.entry?.method === "PATCH"
                    ? "Update offer"
                    : "Create product"} · SKU {r.row.sku || r.row.key}</small
                ></td
              >
              <td
                >{#if tab === "review"}£{r.price.toFixed(2)}<small
                    >Previously {r.row.price}</small
                  >{:else}<label class="sr-only" for={`gbp-${r.row.key}`}
                    >GBP price for {r.row.key}</label
                  ><input
                    id={`gbp-${r.row.key}`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={drafts[r.row.key]?.priceGBP ??
                      r.decision.priceGBP ??
                      ""}
                    placeholder={r.price > 0 ? r.price.toFixed(2) : "Required"}
                    on:input={(e) => edit(r, "priceGBP", e.currentTarget.value)}
                  />{/if}</td
              >
              <td
                >{r.row.onHand}<small>Amazon: {r.row.quantity ?? "—"}</small
                ></td
              >
              <td
                >{#if tab === "review"}{r.productType}{:else}<label
                    class="sr-only"
                    for={`type-${r.row.key}`}
                    >Product type for {r.row.key}</label
                  ><input
                    id={`type-${r.row.key}`}
                    value={drafts[r.row.key]?.productType ?? r.productType}
                    placeholder="e.g. STICKER_DECAL"
                    on:input={(e) =>
                      edit(r, "productType", e.currentTarget.value)}
                  /><button disabled={busy} on:click={() => discover(r)}
                    >Find product type</button
                  >
                  {#each productTypes(r, typeResponses) as suggestion}<button
                      disabled={busy}
                      on:click={() => {
                        edit(r, "productType", suggestion.name);
                      }}>{suggestion.displayName || suggestion.name}</button
                    >{/each}{/if}</td
              >
              <td
                ><span class:problem={blocked(r)}>{status(r)}</span>
                {#if r.job?.validation?.data?.issues?.length && sameEntry(r)}<details
                  >
                    <summary>Amazon feedback</summary
                    >{#each r.job.validation.data.issues as issue}<p>
                        {issue.severity}
                        {issue.code}: {issue.message}
                      </p>{/each}
                  </details>{/if}
                <div class="row-actions">
                  {#if drafts[r.row.key]}<button
                      disabled={busy}
                      on:click={() => save(r)}>Save changes</button
                    >{/if}
                  <button
                    disabled={busy}
                    on:click={() => save(r, { deferred: !r.decision.deferred })}
                    >{r.decision.deferred ? "Resume" : "Later"}</button
                  >
                  {#if blocked(r) || !r.productType}<button
                      on:click={() => dispatch("inspect", r.row)}
                      >Open product tools</button
                    >{/if}
                </div>
              </td></tr
            >
          {/each}
        </tbody>
      </table>
    </div>
    {#if !shown.length}<p>
        No products in this view yet. Return to Prepare products to enter prices
        and check products; unresolved products remain under Needs attention.
      </p>{/if}
    <p class="note">
      Up to 100 products per action. Changing prices, stock, product type or
      mappings requires a new check. Previews expire after 30 minutes.
      Shared-barcode variant creation remains in Needs attention until its
      identity is resolved.
    </p>
  {/if}
</section>

<style>
  .preparation {
    background: #f0f7ff;
    border: 1px solid #b7d4f3;
    border-radius: 0.75rem;
    padding: 1.25rem;
    margin: 1rem 0 1.5rem;
  }
  .intro,
  .actions,
  nav,
  .row-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  .intro {
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 1.3rem;
  }
  p {
    line-height: 1.5;
  }
  nav,
  .actions {
    margin: 1rem 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  button,
  input {
    font: inherit;
    padding: 0.55rem 0.7rem;
    border: 1px solid #94a3b8;
    border-radius: 0.35rem;
    background: white;
    color: #1f2937;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .primary {
    background: #1758aa;
    border-color: #1758aa;
    color: white;
    font-weight: 600;
  }
  .current {
    box-shadow: inset 0 -3px #1758aa;
    font-weight: 600;
  }
  .confirm {
    flex-direction: row;
    align-items: start;
    margin: 1rem 0;
  }
  .table-wrap {
    overflow-x: auto;
    margin: 1rem 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    background: white;
  }
  th,
  td {
    text-align: left;
    padding: 0.8rem;
    border-bottom: 1px solid #dbe3ed;
    vertical-align: top;
  }
  td input:not([type="checkbox"]) {
    width: 9rem;
  }
  small {
    display: block;
    color: #526174;
    margin-top: 0.3rem;
  }
  .row-actions {
    margin-top: 0.6rem;
  }
  .row-actions button {
    padding: 0.35rem 0.5rem;
    font-size: 0.85rem;
  }
  .problem,
  [role="alert"] {
    color: #9a3412;
  }
  .note {
    color: #526174;
    font-size: 0.9rem;
  }
  details {
    margin: 0.7rem 0;
  }
  summary {
    cursor: pointer;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
  }
  @media (max-width: 600px) {
    .preparation {
      padding: 0.8rem;
    }
    .intro .primary {
      width: 100%;
    }
  }
</style>
