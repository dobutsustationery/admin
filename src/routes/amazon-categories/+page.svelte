<script lang="ts">
  import productTypes from "$lib/amazon-product-types.json";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import {
    collection,
    doc,
    writeBatch,
    serverTimestamp,
  } from "firebase/firestore";
  import { amazonCategoryRows, amazonExchangeRate } from "$lib/amazon-defaults";
  import { variationThemes } from "$lib/amazon-variation-family";
  let edits: Record<string, { productType: string; variationTheme: string }> =
    {};
  let rate: string | number = "",
    error = "",
    message = "",
    busy = false;
  $: seller = $store.amazonAudit?.sellerId || "";
  $: rows = amazonCategoryRows($store, seller);
  $: currentRate = amazonExchangeRate($store.amazonPreparation, seller);
  const value = (row: any) =>
    edits[row.category] || {
      productType: row.productType,
      variationTheme: row.variationTheme,
    };
  function edit(row: any, field: string, event: Event) {
    edits = {
      ...edits,
      [row.category]: {
        ...value(row),
        [field]: (event.target as HTMLInputElement).value,
      },
    };
  }
  async function save(chosen: any[], pricing = false) {
    error = "";
    message = "";
    busy = true;
    try {
      if (!$user || !seller)
        throw Error("Sign in and refresh the Amazon catalogue first.");
      const batch = writeBatch(firestore);
      if (pricing) {
        if (!(Number(rate) > 0) || !Number.isFinite(Number(rate)))
          throw Error("Enter a positive exchange rate.");
        batch.set(doc(collection(firestore, "broadcast")), {
          type: "amazonPrepare/policy",
          payload: { sellerId: seller, gbpPerEur: String(rate) },
          creator: $user.uid,
          timestamp: serverTimestamp(),
        });
      }
      for (const row of chosen) {
        const mapping = value(row);
        if (
          !/^[A-Z][A-Z0-9_]{0,99}$/.test(
            mapping.productType.trim().toUpperCase(),
          )
        )
          throw Error(
            `Choose an Amazon product type for ${row.category || "Uncategorized"}.`,
          );
        batch.set(doc(collection(firestore, "broadcast")), {
          type: "amazonPrepare/categoryMapping",
          payload: { sellerId: seller, category: row.category, mapping },
          creator: $user.uid,
          timestamp: serverTimestamp(),
        });
      }
      await batch.commit();
      message = pricing
        ? "Exchange rate saved."
        : `${chosen.length} category mapping(s) saved.`;
      if (!pricing)
        edits = Object.fromEntries(
          Object.entries(edits).filter(
            ([key]) => !chosen.some((r) => r.category === key),
          ),
        );
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Amazon categories</title></svelte:head>
<main>
  <h1>Amazon categories</h1>
  <p>
    Map your Shopify product categories to Amazon UK product types. These
    defaults apply to Amifa listings, including variation families.
  </p>
  <a href="/amazon-listings">Back to Amazon listings</a>
  <section>
    <h2>Pricing</h2>
    <p>
      Amazon GBP price = inventory euro price × exchange rate. Current rate: {currentRate}.
      Prices are rounded to two decimal places.
    </p>
    <label
      >GBP per EUR <input
        type="number"
        min="0.0001"
        step="0.01"
        placeholder={String(currentRate)}
        bind:value={rate}
      /></label
    >
    <button disabled={busy || !seller || !rate} on:click={() => save([], true)}
      >Save exchange rate</button
    >
  </section>
  {#if !seller}<p>
      Refresh the catalogue on Amazon listings to select the configured UK
      seller.
    </p>{/if}
  <p>
    Suggestions are prepopulated and used until you save a different mapping.
    Amazon may require more attributes for some product types; any rejection
    appears on Amazon listings.
  </p>
  <button
    disabled={busy || !seller || !rows.some((r) => value(r).productType)}
    on:click={() => save(rows.filter((r) => value(r).productType))}
    >Save all populated mappings</button
  >
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <datalist id="amazon-product-types"
    >{#each productTypes as type}<option value={type.name}>{type.label}</option
      >{/each}</datalist
  >
  <table>
    <thead
      ><tr
        ><th>Shopify category</th><th>Listings</th><th>Amazon product type</th
        ><th>Variants differ by</th><th>Source</th><th></th></tr
      ></thead
    >
    <tbody
      >{#each rows as row (row.category)}<tr>
          <td>{row.category || "Uncategorized"}<small>{row.example}</small></td
          ><td>{row.products}</td>
          <td
            ><input
              aria-label={`Product type for ${row.category}`}
              value={value(row).productType}
              placeholder="Search Amazon product types"
              list="amazon-product-types"
              on:input={(e) => edit(row, "productType", e)}
            /></td
          >
          <td
            ><select
              aria-label={`Variation theme for ${row.category}`}
              value={value(row).variationTheme}
              on:change={(e) => edit(row, "variationTheme", e)}
              >{#each Object.entries(variationThemes) as [key, theme]}<option
                  value={key}>{theme.label}</option
                >{/each}</select
            ></td
          >
          <td
            >{edits[row.category]
              ? "Unsaved"
              : row.saved
                ? "Saved"
                : row.productType
                  ? "Suggested"
                  : "Needs mapping"}</td
          >
          <td
            ><button
              disabled={busy || !seller || !value(row).productType}
              on:click={() => save([row])}>Save mapping</button
            ></td
          >
        </tr>{/each}</tbody
    >
  </table>
</main>

<style>
  main {
    padding: 1.5rem;
    max-width: 1500px;
    margin: auto;
  }
  section {
    margin: 1.5rem 0;
    padding: 1rem;
    background: #f3f4f6;
    border-radius: 8px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 1rem;
  }
  th,
  td {
    text-align: left;
    border-bottom: 1px solid #d1d5db;
    padding: 0.7rem;
  }
  small {
    display: block;
    color: #6b7280;
    max-width: 30rem;
  }
  input,
  select,
  button {
    padding: 0.5rem;
    border: 1px solid #9ca3af;
    border-radius: 4px;
  }
  button {
    cursor: pointer;
    margin: 0.3rem;
    background: #eff6ff;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .error {
    color: #b91c1c;
  }
  input {
    max-width: 20rem;
  }
</style>
