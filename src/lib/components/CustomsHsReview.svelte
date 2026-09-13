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
  let editing: string | null = null;
  let origin = "";
  let grams = "";
  $: visible = products.filter(
    (p) => filter === "all" || !p.code || !p.en || !p.bg,
  );
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
  <label
    >Show <select bind:value={filter}
      ><option value="unresolved">Needs classification</option><option
        value="all">All products / edit decisions</option
      ></select
    ></label
  >
  <fieldset {disabled}>
    <legend>Assign to {selected.length} selected products</legend>
    <button on:click={() => (selected = visible.map((p) => p.jan))}
      >Select all {visible.length} shown products</button
    >
    <button on:click={() => (selected = [])}>Clear selection</button>
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
                </fieldset>
              {/if}
            </td>
          </tr>
        {/each}</tbody
      >
    </table>
  </div>
  {#if !visible.length}<p>No classifications need review.</p>{/if}
</section>

<style>
  .scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 0.6rem;
    border-bottom: 1px solid #ddd;
    text-align: left;
    vertical-align: top;
  }
  small {
    display: block;
    color: #555;
  }
  label {
    display: inline-flex;
    flex-direction: column;
    margin: 0.3rem;
  }
  fieldset {
    margin: 0.7rem 0;
    border: 1px solid #bbb;
  }
  button {
    margin: 0.2rem;
  }
  input,
  select {
    padding: 0.4rem;
  }
</style>
