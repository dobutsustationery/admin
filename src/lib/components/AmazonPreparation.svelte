<script lang="ts">
  import { onDestroy, createEventDispatcher } from "svelte";
  import { browser } from "$app/environment";
  import { amazonDraftJournal } from "$lib/amazon-draft-journal";
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
    projectPreparation,
    emptyPreparationDraft,
    preparationDraftScope,
    draftHasChanges,
    reducePreparation,
    type PreparationDraft,
    previewValid,
    preparationFingerprint,
    preparationScope,
    type PreparationRow,
    type PreparationDecision,
    type PreparationState,
  } from "$lib/amazon-preparation";
  const dispatch = createEventDispatcher();
  let storageFailed = false;
  let lastRevision = 0;
  let busy = false,
    message = "",
    error = "";
  let journal: ReturnType<typeof amazonDraftJournal> | undefined;
  let journalKey = "";
  let journalState: { events: any[]; error: string } = {
    events: [],
    error: "",
  };
  let unsubscribeJournal = () => {};
  let unsubscribers: (() => void)[] = [];
  onDestroy(() => {
    unsubscribeJournal();
    unsubscribers.forEach((u) => u());
  });
  $: prep = ($store.amazonPreparation ||
    initialPreparation) as PreparationState;
  $: seller = $store.amazonAudit?.sellerId || "";
  $: owner = $user?.uid || "";
  $: scope = preparationDraftScope(seller, owner);
  $: if (browser && seller && owner && scope !== journalKey) {
    unsubscribeJournal();
    journalKey = scope;
    try {
      journal = amazonDraftJournal(owner, seller);
      unsubscribeJournal = journal.subscribe((value) => (journalState = value));
      void journal.flush();
    } catch (e: any) {
      storageFailed = true;
      error = `Could not save drafts on this device: ${e.message}`;
    }
  }
  $: savedDraft = prep.drafts?.[scope];
  $: if (journal && savedDraft)
    journal.observed(savedDraft.revision, savedDraft.token);
  $: effective = journalState.events.reduce(
    (state, event) => reducePreparation(state, event),
    prep,
  ) as PreparationState;
  $: draft = effective.drafts?.[scope] || emptyPreparationDraft();
  $: drafts = draft.decisions;
  $: active = draft.view.active;
  $: query = draft.view.query;
  $: tab = draft.view.tab;
  $: factor =
    draft.gbpPerEur ??
    effective.policies[preparationScope(seller)]?.gbpPerEur ??
    "";
  $: dirty = draftHasChanges(draft);
  $: syncing = journalState.events.length > 0;
  function change(type: string, changes: Record<string, unknown> = {}) {
    if (!journal || !owner || !seller) {
      error = "Sign in and wait for your draft to load.";
      return;
    }
    try {
      lastRevision = Math.max(Date.now(), draft.revision + 1, lastRevision + 1);
      journal.append({
        type,
        payload: {
          sellerId: seller,
          owner,
          ...changes,
          revision: lastRevision,
          token: crypto.randomUUID(),
        },
      });
      storageFailed = false;
      error = "";
    } catch (e: any) {
      storageFailed = true;
      error = `Draft could not be saved. Keep this page open: ${e.message}`;
    }
  }
  function view(changes: Partial<PreparationDraft["view"]>) {
    change("amazonPrepare/draftViewChanged", { changes });
  }
  function decision(
    r: PreparationRow,
    edits: Record<string, PreparationDecision>,
  ) {
    return { ...r.decision, ...edits[r.row.key] };
  }
  function edit(r: PreparationRow, name: string, value: string | boolean) {
    change("amazonPrepare/draftDecisionChanged", {
      itemKey: r.row.key,
      field: name,
      value,
    });
  }

  function applyDraft() {
    if (draft.gbpPerEur && !(Number(draft.gbpPerEur) > 0)) {
      error = "Enter a positive GBP-per-EUR factor.";
      return;
    }
    change("amazonPrepare/draftApplied");
    message =
      "Draft choices applied. Check products with Amazon when ready; nothing has been published.";
  }
  function discardDraft() {
    change("amazonPrepare/draftDiscarded");
    message =
      "Draft discarded. Previously applied choices and Amazon listings are unchanged.";
  }
  $: previewRows = projectPreparation(
    effective,
    $store.amazonAudit,
    $store.inventory,
    $store.listings,
    owner,
  );
  $: inStock = previewRows.filter((r) => r.row.onHand > 0);
  $: pricedCount = inStock.filter(
    (r) => Number.isFinite(r.price) && r.price > 0,
  ).length;
  $: issueGroups = Object.entries(
    inStock.reduce(
      (groups, r) => {
        if (r.reason && r.reason !== "Price and stock already match Amazon.")
          groups[r.reason] = (groups[r.reason] || 0) + 1;
        return groups;
      },
      {} as Record<string, number>,
    ),
  ).sort((a, b) => b[1] - a[1]);
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
    (r) => ready(r, drafts) && decision(r, drafts).included !== false,
  );
  $: stockConfirmed =
    readyRows.length > 0 &&
    JSON.stringify(draft.view.reviewedJobIds) ===
      JSON.stringify(readyRows.map((r) => r.job.id));
  $: checkRows = inStock.filter(
    (r) =>
      r.entry &&
      !drafts[r.row.key] &&
      !pending(r) &&
      !ready(r, drafts) &&
      decision(r, drafts).included !== false,
  );
  $: issues = inStock.filter((r) => decision(r, drafts).deferred || blocked(r));
  $: shown = inStock.filter(
    (r) =>
      (tab === "issues"
        ? decision(r, drafts).deferred || blocked(r)
        : tab === "review"
          ? ready(r, drafts) ||
            pending(r) ||
            ["submitted", "unknown"].includes(r.job?.status)
          : !decision(r, drafts).deferred) &&
      [r.row.title, r.row.jan, r.row.subtype, r.row.sku]
        .join(" ")
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function request(mode: "preview" | "publish") {
    if (dirty || syncing || storageFailed || journalState.error) {
      error =
        "Apply or discard your draft and wait for it to sync before continuing.";
      return;
    }
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
      view({ tab: "review", reviewedJobIds: [] });
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function status(r: PreparationRow) {
    if (drafts[r.row.key])
      return decision(r, drafts).deferred
        ? "Set aside in draft; apply choices to confirm."
        : r.reason || "Draft changes saved; apply choices before checking";
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
      disabled={!seller || !journal || !$store.inventory.initialized}
      on:click={() => view({ active: !active })}
      >{active
        ? "Hide preparation"
        : dirty
          ? "Resume preparation draft"
          : "Prepare Amifa products for Amazon"}</button
    >
  </div>
  {#if !seller}<p>Start by refreshing the seller catalogue below.</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !active && dirty}<p>
      Your preparation draft is saved. Resume it whenever you are ready.
    </p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if journalState.error}<p role="alert">
      Draft saved on this device. Sync failed: {journalState.error}
      <button on:click={() => journal?.flush()}>Retry draft sync</button>
    </p>{/if}
  {#if active}
    <div class="draft-bar">
      <strong
        >{syncing
          ? "Draft saved on this device · syncing…"
          : "Draft saved"}</strong
      >
      <p>
        You can leave this page and return. Prices, product types, selections
        and Later choices remain a draft until you apply them. Applying does not
        publish to Amazon.
      </p>
      <div class="actions">
        <button
          class="primary"
          disabled={busy || storageFailed || !dirty}
          on:click={applyDraft}>Apply draft choices</button
        ><button disabled={busy} on:click={discardDraft}>Discard draft</button
        ><span>{dirty ? "Unapplied choices" : "All choices applied"}</span>
      </div>
    </div>
    <nav aria-label="Preparation steps">
      <button
        class:current={tab === "prepare"}
        on:click={() => view({ tab: "prepare" })}
        >1. Prepare products ({inStock.length})</button
      >
      <button
        class:current={tab === "review"}
        on:click={() => view({ tab: "review" })}
        >2. Review and publish ({readyRows.length} ready)</button
      >
      <button
        class:current={tab === "issues"}
        on:click={() => view({ tab: "issues" })}
        >Needs attention / later ({issues.length})</button
      >
    </nav>
    <p>
      In-stock products are included by default. Uncheck products or choose
      “Later” to leave them out. Checks and publication run independently for
      each product.
    </p>
    {#if tab === "prepare"}
      <details
        open={draft.view.pricingOpen}
        on:toggle={(e) => {
          if (e.currentTarget.open !== draft.view.pricingOpen)
            view({ pricingOpen: e.currentTarget.open });
        }}
      >
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
              value={factor}
              on:input={(e) =>
                change("amazonPrepare/draftPricingChanged", {
                  value: e.currentTarget.value,
                })}
            /></label
          >
        </div>
        <p aria-live="polite">
          {pricedCount} of {inStock.length} in-stock products have a GBP price in
          this preview. The factor applies to all products without an existing Amazon
          price or an individual override, including products with other issues.
          {#if dirty}Choose “Apply draft choices” once to apply these choices to
            all products.{/if}
        </p>
      </details>
    {/if}
    {#if issueGroups.length}
      <details class="issue-summary">
        <summary>What still needs attention ({issues.length} products)</summary>
        <p>
          Setting prices does not resolve product identity or product-type
          requirements.
        </p>
        <ul>
          {#each issueGroups as [reason, count]}<li>
              <strong>{count} products:</strong>
              {reason}
            </li>{/each}
        </ul>
      </details>
    {/if}
    <div class="actions">
      <label
        >Filter preparation <input
          type="search"
          value={query}
          on:input={(e) => view({ query: e.currentTarget.value })}
          placeholder="Product, barcode or variant"
        /></label
      >
      {#if tab !== "review"}<button
          class="primary"
          disabled={busy ||
            storageFailed ||
            dirty ||
            syncing ||
            !!journalState.error ||
            !checkRows.length}
          on:click={() => request("preview")}
          >Check {Math.min(checkRows.length, 100)} products with Amazon</button
        >{/if}
      <span>{issues.length} products can be addressed later.</span>
    </div>
    {#if tab === "review"}
      <p>
        Review the exact price and stock below. Publishing updates only price
        and merchant-fulfilled stock for existing listings; new products are
        created individually. Validation may still be followed by delayed Amazon
        processing or further issues.
      </p>
      <label class="confirm"
        ><input
          type="checkbox"
          checked={stockConfirmed}
          on:change={(e) =>
            view({
              reviewedJobIds: e.currentTarget.checked
                ? readyRows.map((r) => r.job.id)
                : [],
            })}
        /> I have checked these quantities, including any recent Amazon sales not
        yet recorded here.</label
      >
      <button
        class="primary"
        disabled={busy ||
          storageFailed ||
          dirty ||
          syncing ||
          !!journalState.error ||
          !readyRows.length ||
          !stockConfirmed}
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
                  checked={decision(r, drafts).included !== false}
                  on:change={(e) =>
                    edit(r, "included", e.currentTarget.checked)}
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
                  />
                  {#if Number.isFinite(r.price) && r.price > 0}<small
                      >Preview: £{r.price.toFixed(2)}</small
                    >{/if}
                {/if}</td
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
                  <button
                    disabled={busy}
                    on:click={() =>
                      edit(r, "deferred", !decision(r, drafts).deferred)}
                    >{decision(r, drafts).deferred ? "Resume" : "Later"}</button
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
  .draft-bar {
    background: white;
    padding: 1rem;
    margin: 1rem 0;
    border: 1px solid #b7d4f3;
    border-radius: 0.5rem;
  }
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
