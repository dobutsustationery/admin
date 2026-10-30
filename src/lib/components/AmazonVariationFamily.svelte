<script lang="ts">
  import { browser } from "$app/environment";
  import {
    collection,
    doc,
    writeBatch,
    serverTimestamp,
    onSnapshot,
    addDoc,
    query as firestoreQuery,
    where,
  } from "firebase/firestore";
  import { onDestroy, onMount } from "svelte";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import ImageThumbnail from "./ImageThumbnail.svelte";
  import {
    buildAmazonVariationFamily,
    familyDecision,
    familyDecisionKey,
    variationThemes,
  } from "$lib/amazon-variation-family";
  import {
    preparationFingerprint,
    previewValid,
    type PreparationDecision,
    type PreparationRow,
  } from "$lib/amazon-preparation";
  import { amazonProductTypeLookup } from "$lib/amazon-product-type-lookup";
  import { auditScope, UK_MARKETPLACE } from "$lib/amazon-audit";
  export let rows: PreparationRow[] = [];
  export let familyHandle = "";
  export let exemptionSelected = false;
  let now = Date.now();
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 10000);
    return () => clearInterval(timer);
  });
  let handle = "",
    search = "",
    open = false,
    loaded = "",
    storageError = "";
  let choices: PreparationDecision = {},
    children: Record<string, PreparationDecision> = {};
  let queuedRequestId = "";
  let typeLookup: { id: string; title: string } | null = null;
  let typeLookupAppliedId = "";
  let typeEvents: Record<string, any> = {};
  let typeWatchingId = "",
    typeReadError = "";
  let stopTypeLookup = () => {};
  onDestroy(() => stopTypeLookup());
  let busy = false,
    error = "",
    message = "",
    confirmed = false,
    confirmationKey = "";
  let stops: (() => void)[] = [];
  onDestroy(() => stops.forEach((stop) => stop()));
  $: seller = $store.amazonAudit?.sellerId || "";
  $: owner = $user?.uid || "";
  $: scope = `amazon-variation-family:${firestore.app.options.projectId}:${seller}:${owner}`;
  $: families = (
    Object.entries($store.listings.handleToListing) as [string, any][]
  ).filter(
    ([h, l]: [string, any]) =>
      /^amifa\b/i.test(l.title || "") &&
      rows.filter((r) => r.row.family === h).length >= 2,
  );
  $: filteredFamilies = families.filter(([h, l]: [string, any]) =>
    `${h} ${l.title}`.toLowerCase().includes(search.toLowerCase()),
  );
  $: if (browser && seller && owner && rows.length > 0 && loaded !== scope) {
    loaded = scope;
    try {
      handle = familyHandle || localStorage.getItem(scope + ":selected") || "";
      open = !!familyHandle;
      load();
      if (
        familyHandle &&
        exemptionSelected &&
        choices.identifierExemption === undefined
      ) {
        choices = { ...choices, identifierExemption: true };
        save();
      }
    } catch (e: any) {
      storageError = `Could not restore family choices: ${e.message}`;
    }
  }
  function load() {
    if (!browser || !handle) return;
    try {
      const saved = JSON.parse(
        localStorage.getItem(`${scope}:${handle}`) || "null",
      );
      choices =
        saved?.choices ||
        familyDecision($store.amazonPreparation, seller, handle);
      children =
        saved?.children ||
        Object.fromEntries(
          rows
            .filter((r) => r.row.family === handle)
            .map((r) => [
              r.row.key,
              {
                ...r.decision,
                priceGBP: r.price > 0 ? r.price.toFixed(2) : "",
                variationValue:
                  r.decision.variationValue ||
                  $store.listings.handleToListing[handle]
                    ?.variantOptionsByItemId?.[r.row.key] ||
                  r.row.subtype ||
                  "",
              },
            ]),
        );
      queuedRequestId = saved?.queuedRequestId || "";
      typeLookup = saved?.typeLookup || null;
      typeLookupAppliedId = saved?.typeLookupAppliedId || "";
      if (queuedRequestId) watchRequest(queuedRequestId);
      localStorage.setItem(scope + ":selected", handle);
      error = "";
      message = "";
      confirmed = false;
    } catch (e: any) {
      storageError = `Could not restore family choices: ${e.message}`;
    }
  }
  function save() {
    try {
      localStorage.setItem(
        `${scope}:${handle}`,
        JSON.stringify({
          choices,
          children,
          queuedRequestId,
          typeLookup,
          typeLookupAppliedId,
        }),
      );
      storageError = "";
      confirmed = false;
    } catch (e: any) {
      storageError = `Could not save family choices: ${e.message}`;
    }
  }
  function editChoice(field: string, value: string | boolean) {
    choices = { ...choices, [field]: value };
    save();
  }
  function editChild(key: string, field: string, value: string) {
    children = { ...children, [key]: { ...children[key], [field]: value } };
    save();
  }
  $: familyRows = rows
    .filter((r) => r.row.family === handle)
    .map((r) => ({
      ...r,
      decision: { ...r.decision, ...children[r.row.key] },
      price: children[r.row.key]?.priceGBP?.trim()
        ? Number(children[r.row.key].priceGBP)
        : r.price,
    }));
  $: plan = buildAmazonVariationFamily({
    handle,
    rows: familyRows,
    inventory: $store.inventory,
    listings: $store.listings,
    decision: choices,
  });
  $: jobs = Object.values($store.amazonPreparation.jobs).filter(
    (j: any) => j.sellerId === seller && j.entry?.family?.handle === handle,
  ) as any[];
  $: parent = jobs
    .filter((j) => j.entry.family.role === "parent")
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
  $: currentJobs = parent
    ? jobs.filter((j) => j.id === parent.id || j.parentJobId === parent.id)
    : [];
  $: matches = plan.entries.map((entry) =>
    currentJobs.find(
      (j) =>
        j.entry.sku === entry.sku &&
        preparationFingerprint(j.entry) === preparationFingerprint(entry),
    ),
  );
  $: pending =
    !!queuedRequestId ||
    currentJobs.some((j) =>
      ["queued", "publish_queued", "publishing", "readback_pending"].includes(
        j.status,
      ),
    );
  $: if (
    queuedRequestId &&
    currentJobs.some(
      (j) =>
        j.previewRequestId === queuedRequestId ||
        j.publishRequestId === queuedRequestId,
    )
  ) {
    queuedRequestId = "";
    save();
  }
  $: uncertain = currentJobs.some((j) => j.status === "unknown");
  $: allReady =
    !!plan.entries.length &&
    matches.length === plan.entries.length &&
    matches.every(
      (j) =>
        j?.status === "ready" &&
        previewValid(j) &&
        now - (j.validatedAt || j.updatedAt) < 1800000,
    );
  $: if (
    confirmationKey !== preparationFingerprint([plan.entries, parent?.id])
  ) {
    confirmationKey = preparationFingerprint([plan.entries, parent?.id]);
    confirmed = false;
  }
  function observation(entry: any) {
    return $store.amazonAudit.observations[
      auditScope(seller, UK_MARKETPLACE, entry.sku)
    ];
  }
  function result(entry: any) {
    const j = currentJobs.find((job) => job.entry.sku === entry.sku);
    if (!j || preparationFingerprint(j.entry) !== preparationFingerprint(entry))
      return "Not checked with these choices";
    if (j.status === "ready")
      return j.reuseParent
        ? "Existing parent confirmed · will reuse"
        : "Validated · ready to publish";
    if (j.status === "blocked" || j.status === "unknown") return j.error;
    if (j.status === "queued") return "Queued for Amazon validation";
    if (["publish_queued", "publishing", "readback_pending"].includes(j.status))
      return j.error || "Publication / Amazon confirmation in progress";
    const observed = observation(entry);
    if (!observed || observed.at <= j.submittedAt)
      return "Submitted · waiting for Amazon readback";
    const raw = observed.raw,
      a = raw?.attributes || {};
    const issues = (raw?.issues || []).filter(
      (i: any) => i.severity === "ERROR",
    );
    if (issues.length)
      return issues.map((i: any) => `${i.code}: ${i.message}`).join(" · ");
    if (observed.status !== 200)
      return `Amazon readback returned HTTP ${observed.status}`;
    const role = a.parentage_level?.[0]?.value,
      theme = a.variation_theme?.[0]?.name;
    if (role !== entry.family.role || theme !== entry.family.theme)
      return "Amazon has not confirmed this variation relationship yet";
    if (entry.family.role === "parent") return "Parent confirmed on Amazon";
    if (
      !a.child_parent_sku_relationship?.some(
        (v: any) => v.parent_sku === entry.family.parentSku,
      )
    )
      return "Amazon has not linked this child to the parent yet";
    const qty = entry.body.attributes.fulfillment_availability[0].quantity,
      price =
        entry.body.attributes.purchasable_offer[0].our_price[0].schedule[0]
          .value_with_tax;
    if (
      !raw.fulfillmentAvailability?.some(
        (v: any) =>
          v.fulfillmentChannelCode === "DEFAULT" && v.quantity === qty,
      ) ||
      !raw.offers?.some(
        (o: any) =>
          (o.price?.currencyCode || o.price?.currency) === "GBP" &&
          Number(o.price?.amount) === price,
      )
    )
      return "Relationship confirmed · price or stock still processing";
    return `Child, price and stock confirmed${raw.summaries?.some((s: any) => s.status?.includes("BUYABLE")) ? " · buyable" : " · not yet reported buyable"}`;
  }
  async function request(mode: "preview" | "publish") {
    if (
      !owner ||
      !seller ||
      busy ||
      storageError ||
      plan.reason ||
      pending ||
      uncertain ||
      (mode === "publish" && (!allReady || !confirmed))
    )
      return;
    busy = true;
    error = "";
    try {
      const ref = doc(collection(firestore, "request_amazon_prepare"));
      const batch = writeBatch(firestore);
      if (mode === "preview") {
        for (const [key, decision] of [
          [familyDecisionKey(handle), choices],
          ...familyRows.map((r) => [r.row.key, children[r.row.key] || {}]),
        ] as [string, PreparationDecision][]) {
          batch.set(doc(collection(firestore, "broadcast")), {
            type: "amazonPrepare/decision",
            creator: owner,
            timestamp: serverTimestamp(),
            payload: { sellerId: seller, itemKey: key, decision },
          });
        }
      }
      batch.set(ref, {
        creator: owner,
        sellerId: seller,
        marketplaceId: UK_MARKETPLACE,
        mode,
        ...(mode === "preview"
          ? { entries: plan.entries }
          : { jobIds: matches.map((j) => j.id), stockConfirmed: true }),
        createdAt: serverTimestamp(),
      });
      await batch.commit();
      message =
        mode === "preview"
          ? "Family validation queued on the server. Nothing has been published. You can leave and return."
          : "Family publication queued. The server will confirm the parent before sending children. You can leave and return.";
      confirmed = false;
      queuedRequestId = ref.id;
      save();
      watchRequest(ref.id);
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  function watchRequest(id: string) {
    stops.push(
      onSnapshot(
        doc(firestore, "request_amazon_prepare", id),
        (snapshot) => {
          if (snapshot.data()?.error) {
            error = snapshot.data()?.error;
            if (queuedRequestId === id) {
              queuedRequestId = "";
              save();
            }
          }
        },
        (e) => (error = e.message),
      ),
    );
  }
  $: if ((typeLookup?.id || "") !== typeWatchingId) {
    stopTypeLookup();
    typeEvents = {};
    typeReadError = "";
    typeWatchingId = typeLookup?.id || "";
    if (typeWatchingId) {
      const id = typeWatchingId;
      stopTypeLookup = onSnapshot(
        firestoreQuery(
          collection(firestore, "sync"),
          where("requestId", "==", id),
        ),
        (snapshot) => {
          if (typeWatchingId === id)
            typeEvents = Object.fromEntries(
              snapshot.docs.map((d) => [d.id, d.data()]),
            );
        },
        (e) =>
          (typeReadError = `Unable to read product type lookup results: ${e.message}`),
      );
    }
  }
  $: typeLookupResult = amazonProductTypeLookup({
    responses: $store.amazonCatalog?.rawResponsesById || {},
    events: { ...$store.syncQueue?.eventsById, ...typeEvents },
    seller,
    title:
      typeLookup?.title || $store.listings.handleToListing[handle]?.title || "",
    requestId: typeLookup?.id,
  });
  $: productTypeSuggestions = typeLookupResult.types;
  $: if (
    handle &&
    loaded === scope &&
    typeLookupResult.status === "success" &&
    productTypeSuggestions.length === 1 &&
    typeLookupAppliedId !== typeLookupResult.requestId
  ) {
    typeLookupAppliedId = typeLookupResult.requestId;
    if (!choices.productType?.trim())
      choices = { ...choices, productType: productTypeSuggestions[0].name };
    save();
  }
  async function suggestProductTypes() {
    if (!owner || !familyRows.length) return;
    busy = true;
    error = "";
    try {
      const ref = await addDoc(
        collection(firestore, "request_amazon_product_type_discovery"),
        {
          eventType: "amazon/product_type_discovery_requested",
          creator: owner,
          requestedBy: owner,
          source: "amazon-variation-family",
          handle,
          itemKey: familyRows[0].row.key,
          itemName: $store.listings.handleToListing[handle].title,
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
      typeLookup = {
        id: ref.id,
        title: $store.listings.handleToListing[handle].title,
      };
      save();
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
  async function refresh() {
    if (!owner || !plan.entries.length) return;
    try {
      await addDoc(collection(firestore, "request_amazon_audit"), {
        creator: owner,
        marketplaceId: UK_MARKETPLACE,
        mode: "selected",
        skus: plan.entries.map((e) => e.sku),
        createdAt: serverTimestamp(),
      });
      message = "Family readback queued on the server.";
    } catch (e: any) {
      error = e.message;
    }
  }
</script>

<section class="family-builder" aria-label="Create Amazon variation family">
  <h2>
    {familyHandle
      ? "Prepare variants for Amazon"
      : "Create an Amifa listing with variants"}
  </h2>
  <p>
    Prepare one parent listing with a child for each local variant. Validate
    with Amazon, review the family, then publish.
  </p>
  {#if !familyHandle}<button on:click={() => (open = !open)}
      >{open ? "Hide variant family" : "Prepare variant family"}</button
    >{/if}
  {#if open}
    {#if !seller}<p>Refresh the Amazon seller catalogue first.</p>{/if}
    {#if !familyHandle}<div class="controls">
        <label
          >Find Amifa product<input type="search" bind:value={search} /></label
        >
        <label
          >Product family<select
            aria-label="Product family"
            value={handle}
            on:change={(e) => {
              handle = e.currentTarget.value;
              load();
            }}
            ><option value="">Choose a product</option
            >{#each filteredFamilies as [h, l]}<option value={h}
                >{l.title}</option
              >{/each}</select
          ></label
        >
      </div>
    {/if}
    {#if handle && familyRows.length}
      <div class="controls">
        <label
          >Amazon product type<input
            aria-label="Family Amazon product type"
            value={choices.productType || ""}
            placeholder="e.g. STICKER_DECAL"
            on:change={(e) =>
              editChoice(
                "productType",
                e.currentTarget.value.trim().toUpperCase(),
              )}
          /></label
        >
        <label
          >Variants differ by<select
            aria-label="Variants differ by"
            value={choices.variationTheme || ""}
            on:change={(e) =>
              editChoice("variationTheme", e.currentTarget.value)}
            ><option value="">Choose variation type</option
            >{#each Object.entries(variationThemes) as [theme, option]}<option
                value={theme}>{option.label} ({theme})</option
              >{/each}</select
          ></label
        >
      </div>
      <div class="controls">
        <button disabled={busy} on:click={suggestProductTypes}
          >Suggest product types</button
        >{#each productTypeSuggestions as suggestion}<button
            on:click={() => editChoice("productType", suggestion.name)}
            >{suggestion.displayName || suggestion.name}</button
          >{/each}
      </div>
      {#if typeReadError}<p role="alert">{typeReadError}</p>{/if}
      {#if typeLookupResult.status === "pending"}<p role="status">
          Looking up Amazon product types…
        </p>
      {:else if typeLookupResult.status === "error"}<p role="alert">
          {typeLookupResult.error}
        </p>
      {:else if typeLookupResult.status === "empty"}<p role="status">
          Amazon returned no product types for this title. Enter a product type
          manually or adjust the title and try again.
        </p>
      {:else if typeLookupResult.status === "success"}<p role="status">
          {productTypeSuggestions.length === 1 &&
          choices.productType === productTypeSuggestions[0].name
            ? `Amazon suggested ${productTypeSuggestions[0].displayName || productTypeSuggestions[0].name}; selected ${productTypeSuggestions[0].name}.`
            : `Amazon returned ${productTypeSuggestions.length} product type suggestions. Choose one above.`}
        </p>{/if}
      <p>
        Amazon validation checks whether this variation type is supported by the
        chosen product type.
      </p>
      <p>
        Set the Amazon prices in GBP below. Your local inventory prices are in
        EUR.
      </p>
      <table>
        <thead
          ><tr
            ><th>Variant</th><th>Photo</th><th>Variation value</th><th
              >Identifier</th
            ><th>GBP price</th><th>Stock</th></tr
          ></thead
        ><tbody>
          {#each familyRows as r}<tr
              ><td
                >{r.row.subtype || r.row.jan}<small
                  >SKU {r.row.sku || r.row.key}</small
                ></td
              ><td
                ><ImageThumbnail
                  src={$store.inventory.idToItem[r.row.key]?.image || ""}
                  alt={r.row.subtype}
                  width="64px"
                  height="64px"
                  fit="contain"
                /></td
              >
              <td
                ><input
                  aria-label={`Variation value for ${r.row.key}`}
                  value={children[r.row.key]?.variationValue || ""}
                  on:change={(e) =>
                    editChild(
                      r.row.key,
                      "variationValue",
                      e.currentTarget.value,
                    )}
                /></td
              >
              <td>
                {#if choices.identifierExemption && r.row.sharedJan && !children[r.row.key]?.identifierEAN}
                  GTIN exempt<small>Source JAN: {r.row.jan}</small>
                {:else}
                  <input
                    aria-label={`Child EAN for ${r.row.key}`}
                    value={children[r.row.key]?.identifierEAN || ""}
                    placeholder={r.row.jan}
                    on:change={(e) =>
                      editChild(
                        r.row.key,
                        "identifierEAN",
                        e.currentTarget.value.trim(),
                      )}
                  /><small>Leave blank to use {r.row.jan}.</small>{/if}
              </td>
              <td
                ><input
                  aria-label={`Family GBP price for ${r.row.key}`}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={children[r.row.key]?.priceGBP || ""}
                  on:change={(e) =>
                    editChild(r.row.key, "priceGBP", e.currentTarget.value)}
                /><small
                  >Local: €{Number(
                    $store.inventory.idToItem[r.row.key]?.price || 0,
                  ).toFixed(2)}</small
                ></td
              ><td>{r.row.onHand}</td>
            </tr>{/each}
        </tbody>
      </table>
      {#if familyRows.some((r) => r.row.sharedJan)}<fieldset>
          <legend>Variants sharing a JAN</legend>
          <p>
            Amazon children need distinct identifiers. Alternatively, use a GTIN
            exemption already approved by Amazon for amifa and this product
            type.
          </p>
          <label class="inline"
            ><input
              type="checkbox"
              checked={!!choices.identifierExemption}
              on:change={(e) =>
                editChoice("identifierExemption", e.currentTarget.checked)}
            />Amazon has approved the applicable amifa GTIN exemption</label
          ><label
            >Approval reference or note (optional)<input
              value={choices.exemptionReference || ""}
              on:change={(e) =>
                editChoice("exemptionReference", e.currentTarget.value)}
            /></label
          >
        </fieldset>{/if}
      {#if plan.reason}<p role="status">{plan.reason}</p>{:else}<p>
          Parent SKU: <strong>{plan.parentSku}</strong> · {familyRows.length} children.
          The parent has no price or stock.
        </p>{/if}
      {#if storageError || error}<p role="alert">
          {storageError || error}
        </p>{/if}
      {#if message}<p role="status">{message}</p>{/if}
      <div class="controls">
        <button
          disabled={!seller ||
            busy ||
            !!plan.reason ||
            !!storageError ||
            pending ||
            uncertain ||
            allReady}
          on:click={() => request("preview")}
          >Save and check variant family with Amazon</button
        >{#if currentJobs.some((j) => j.submittedAt)}<button
            disabled={busy || !plan.entries.length}
            on:click={refresh}>Refresh family from Amazon</button
          >{/if}
      </div>
      {#if currentJobs.length}<h3>Family validation and publication</h3>
        <ul>
          {#each plan.entries as entry}<li>
              <strong
                >{entry.family?.role === "parent"
                  ? "Parent"
                  : entry.body.attributes[entry.family?.attribute || ""]?.[0]
                      ?.value} · {entry.sku}</strong
              >: {result(entry)}
            </li>{/each}
        </ul>{/if}
      {#if allReady}<div class="publish">
          <h3>Review and publish this family</h3>
          <p>
            The parent and all {familyRows.length} children passed their checks. Review
            the child prices, quantities, identifiers and images above.
          </p>
          <label class="inline"
            ><input type="checkbox" bind:checked={confirmed} />I have reviewed
            this family and the current stock, including Amazon sales.</label
          ><button
            disabled={busy || !confirmed}
            on:click={() => request("publish")}
            >Publish reviewed variant family</button
          >
        </div>{/if}
    {/if}
  {/if}
</section>

<style>
  .family-builder {
    border: 1px solid #94a3b8;
    border-radius: 0.5rem;
    padding: 1.25rem;
    margin: 1rem 0;
    background: #f0f7ff;
  }
  .controls {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    margin: 1rem 0;
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
  input,
  select,
  button {
    font: inherit;
    padding: 0.5rem;
    border: 1px solid #94a3b8;
    border-radius: 0.3rem;
  }
  button {
    cursor: pointer;
    background: white;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  table {
    width: 100%;
    display: block;
    overflow-x: auto;
    border-collapse: collapse;
    background: white;
  }
  td,
  th {
    padding: 0.6rem;
    text-align: left;
    border-bottom: 1px solid #ddd;
  }
  td input {
    width: 9rem;
  }
  small {
    display: block;
    margin-top: 0.3rem;
    color: #526174;
  }
  [role="alert"] {
    color: #b91c1c;
  }
  .publish {
    border: 1px solid #94a3b8;
    padding: 1rem;
    background: white;
  }
</style>
