<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { HS_CODE_DESCRIPTIONS } from "$lib/hscodes";
  import type {
    CustomsProduct,
    CustomsDecision,
  } from "$lib/customs-summary-model";
  export let products: CustomsProduct[] = [];
  export let disabled = false;
  const dispatch = createEventDispatcher<{
    decision: { jans: string[]; decision: CustomsDecision };
  }>();
  let selected: string[] = [];
  let code = "";
  let en = "";
  let bg = "";
  let filter = "unresolved";
  let search = "";
  let editing: string | null = null;
  let origin = "";
  let grams = "";
  $: query = search.normalize("NFKC").trim().toLocaleLowerCase();
  $: visible = products.filter(
    (p) =>
      (filter === "all" || !p.code || !p.en || !p.bg) &&
      [
        p.jan,
        p.description,
        p.manufacturer,
        p.material,
        p.origin,
        p.code,
        p.en,
        p.bg,
      ]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(query),
  );
  // Bulk actions must never include products hidden by either filter.
  $: selected = selected.filter((jan) => visible.some((p) => p.jan === jan));
  function choose(
    jans: string[],
    suggestion: CustomsProduct["suggestions"][number],
  ) {
    dispatch("decision", {
      jans,
      decision: {
        code: suggestion.code,
        en: suggestion.en || "",
        bg: suggestion.bg || "",
      },
    });
  }
</script>

<section>
  <h2>Review HS classifications</h2>
  <p>
    Suggestions require your acceptance. If none fits, choose or enter a code
    manually. These decisions affect this report only.
  </p>
  <div class="filters">
    <label class="search"
      >Filter products <input
        type="search"
        bind:value={search}
        placeholder="Search products, e.g. pen"
      />
    </label>
    <label
      >Show <select bind:value={filter}
        ><option value="unresolved">Needs classification</option><option
          value="all">All products / edit decisions</option
        ></select
      ></label
    >
  </div>
  <p class="result-count" aria-live="polite">
    Showing {visible.length} of {products.length} products
  </p>
  <fieldset class="bulk-actions" {disabled}>
    <legend>Assign to {selected.length} selected products</legend>
    <div class="selection-actions">
      <button on:click={() => (selected = visible.map((p) => p.jan))}
        >Select all {visible.length} shown products</button
      >
      <button on:click={() => (selected = [])}>Clear selection</button>
    </div>
    <label
      >HS code <input
        list="customs-hs-codes"
        bind:value={code}
        placeholder="Eight digits"
      /></label
    >
    <label
      >English override <input
        bind:value={en}
        placeholder="Dictionary default"
      /></label
    >
    <label
      >Bulgarian override <input
        bind:value={bg}
        placeholder="Dictionary default"
      /></label
    >
    <button
      class="primary"
      disabled={!selected.length || !/^\d{8}$/.test(code)}
      on:click={() => {
        dispatch("decision", { jans: selected, decision: { code, en, bg } });
        selected = [];
      }}>Apply code to selected products</button
    >
  </fieldset>
  <datalist id="customs-hs-codes"
    >{#each Object.entries(HS_CODE_DESCRIPTIONS) as [value, label]}<option
        {value}>{label}</option
      >{/each}</datalist
  >
  <div class="scroll">
    <table>
      <thead
        ><tr
          ><th>Select</th><th>Product / source row</th><th
            >Current classification</th
          ><th>Suggestions / manual entry</th></tr
        ></thead
      >
      <tbody
        >{#each visible as p (p.jan)}
          <tr>
            <td
              ><input
                type="checkbox"
                aria-label={`Select ${p.jan}`}
                value={p.jan}
                bind:group={selected}
                {disabled}
              /></td
            >
            <td
              ><strong>{p.jan}</strong><br />{p.description}<br /><small
                >{p.manufacturer} · {p.material} · {p.origin} · {p.grams} g · Order
                row {p.row}</small
              ></td
            >
            <td
              >{p.code || "Manual classification required"}<br />{p.en}<br
              />{p.bg}<br /><small>{p.basis}</small></td
            >
            <td>
              {#each p.suggestions as suggestion}
                <div>
                  <button
                    class="primary"
                    {disabled}
                    on:click={() => choose([p.jan], suggestion)}
                    >Accept {suggestion.code} — {HS_CODE_DESCRIPTIONS[
                      suggestion.code
                    ] || "suggested code"}</button
                  ><small>{suggestion.reason}</small>
                </div>
              {/each}
              <button
                {disabled}
                on:click={() => {
                  editing = p.jan;
                  code = p.code;
                  en = "";
                  bg = "";
                  origin = p.origin;
                  grams = String(p.grams);
                }}>Enter / override classification and details</button
              >
              {#if editing === p.jan}
                <fieldset {disabled}>
                  <legend>{p.jan}</legend>
                  <label
                    >HS code <input
                      list="customs-hs-codes"
                      bind:value={code}
                    /></label
                  >
                  <label
                    >English <input
                      bind:value={en}
                      placeholder="Dictionary default"
                    /></label
                  >
                  <label
                    >Bulgarian <input
                      bind:value={bg}
                      placeholder="Dictionary default"
                    /></label
                  >
                  <label>Origin <input bind:value={origin} /></label>
                  <label
                    >Grams per piece <input
                      bind:value={grams}
                      inputmode="decimal"
                    /></label
                  >
                  <button
                    disabled={!/^\d{8}$/.test(code)}
                    on:click={() => {
                      dispatch("decision", {
                        jans: [p.jan],
                        decision: { code, en, bg, origin, grams },
                      });
                      editing = null;
                    }}>Save decision</button
                  >
                  <button on:click={() => (editing = null)}>Cancel</button>
                </fieldset>
              {/if}
            </td>
          </tr>
        {/each}</tbody
      >
    </table>
  </div>
  {#if !visible.length}<p class="empty">
      {query
        ? "No products match this filter."
        : filter === "all"
          ? "No products to show."
          : "No classifications need review."}
    </p>{/if}
</section>

<style>
  section {
    margin: 1.5rem 0;
    padding: 1.5rem;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    background: white;
    box-shadow: 0 1px 3px #0f172a08;
    color: #1e293b;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 1.3rem;
  }
  p {
    color: #64748b;
    line-height: 1.5;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 1rem;
    margin-top: 1.25rem;
  }
  .search {
    flex: 1;
    min-width: 220px;
  }
  .result-count {
    margin: 0.65rem 0 1rem;
    font-size: 0.85rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
    min-width: 0;
  }
  input:not([type="checkbox"]),
  select {
    width: 100%;
    min-height: 40px;
    padding: 0.6rem 0.75rem;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font: inherit;
    font-weight: 400;
    color: #1e293b;
    background: white;
  }
  input:focus-visible,
  select:focus-visible,
  button:focus-visible {
    outline: 3px solid #93c5fd;
    outline-offset: 2px;
  }
  input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--primary-color);
    cursor: pointer;
  }
  fieldset {
    min-width: 0;
    padding: 1rem;
    margin: 0.75rem 0;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    background: #f8fafc;
  }
  legend {
    padding: 0 0.4rem;
    font-size: 0.9rem;
    font-weight: 600;
  }
  .bulk-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.85rem;
    margin-bottom: 1.25rem;
  }
  .bulk-actions > label {
    flex: 1 1 160px;
  }
  .selection-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    width: 100%;
  }
  button {
    min-height: 36px;
    padding: 0.5rem 0.8rem;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    background: white;
    color: #334155;
    font: inherit;
    font-size: 0.85rem;
    line-height: 1.4;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: #94a3b8;
    background: #f1f5f9;
  }
  button.primary {
    background: var(--primary-color);
    border-color: var(--primary-color);
    color: white;
  }
  button.primary:hover:not(:disabled) {
    background: #00438b;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .scroll {
    overflow-x: auto;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  table {
    width: 100%;
    min-width: 850px;
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th,
  td {
    padding: 0.9rem 1rem;
    border-bottom: 1px solid #e2e8f0;
    text-align: left;
    vertical-align: top;
    line-height: 1.5;
  }
  th {
    background: #f8fafc;
    color: #475569;
    font-size: 0.8rem;
    font-weight: 600;
  }
  th:first-child {
    width: 56px;
  }
  th:nth-child(2) {
    width: 32%;
  }
  th:nth-child(3) {
    width: 23%;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  tbody tr:hover {
    background: #f8fafc;
  }
  small {
    display: block;
    margin: 0.3rem 0 0.6rem;
    font-size: 0.78rem;
    color: #64748b;
  }
  td button {
    margin-bottom: 0.4rem;
  }
  td fieldset label {
    margin-bottom: 0.7rem;
  }
  .empty {
    padding: 1.5rem;
    text-align: center;
    background: #f8fafc;
    border-radius: 8px;
  }
  @media (max-width: 640px) {
    section {
      padding: 1rem;
    }
    .filters > label {
      width: 100%;
    }
    .bulk-actions > label {
      flex-basis: 100%;
    }
  }
</style>
