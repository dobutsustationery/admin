<script lang="ts">
import { goto } from "$app/navigation";
import { createEventDispatcher } from "svelte";
import SelectBox from "./SelectBox.svelte";
import type { Item } from "./inventory";
import { store } from "./store";

export const key = "";
export const row = -1;
export const qty = -1;
export const immutable = false;
export const showdates = false;

let state = store.getState();
let item: Item | null = null;
$: if ($store) {
  state = store.getState();
  item = { ...state.inventory.idToItem[key] };
}

const dispatchEvent = createEventDispatcher();
function updateQty() {
  dispatchEvent("qty", qty);
}
function handleEnterKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    const target = e.target as HTMLInputElement;
    target.blur();
  }
}

function updateSubtype(key: string) {
  return (e: CustomEvent) => {
    const subtype = e.detail;
    dispatchEvent("subtype", subtype);
  };
}

function itemHistory(itemKey: string) {
  goto(`/itemhistory?itemKey=${itemKey}`);
}
</script>

{#if key && item !== null}
  <tr class={row % 2 === 0 ? "even" : "odd"}>
    {#if showdates}
      <td>{item.creationDate}</td>
    {/if}
    <td><img alt="snapshot" height="75" src={item.image} /></td>
    <td>{item.description}</td>
    <td on:click={() => itemHistory(`${item?.janCode}${item?.subtype}`)}
      >{item.janCode}</td
    >
    <td
      >{#if !immutable}<SelectBox
          barcode={item.janCode}
          label=""
          value={item.subtype}
          id="Subtype"
          on:value={updateSubtype(key)}
        />{:else}{item.subtype}{/if}</td
    >
    <td
      >{#if !immutable}<input
          class="qty"
          type="number"
          bind:value={qty}
          on:keyup={handleEnterKey}
          on:blur={updateQty}
        />{:else}{qty}{/if}</td
    >
  </tr>
{/if}

<style>
  .odd {
    background-color: bisque;
  }

  td {
    padding: 0.3em;
  }

  input[type="number"] {
    width: 4em;
    text-align: right;
    background-color: #fff0;
    border: none;
  }
</style>
