<script lang="ts">
import { createEventDispatcher } from "svelte";
import type { Item } from "./inventory";
import SelectBox from "./SelectBox.svelte";
import { store } from "./store";

export const key: string = "";
export const row: number = -1;
export const qty: number = -1;

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
</script>

{#if key && item !== null}
  <tr class={row % 2 === 0 ? "even" : "odd"}>
    <td><img alt="snapshot" height="75" src={item.image} /></td>
    <td>{item.description}</td>
    <td>{item.janCode}</td>
    <td><SelectBox barcode={item.janCode} label="" value={item.subtype} id="Subtype" on:value={updateSubtype(key)}/></td>
    <td
      ><input
        class="qty"
        type="number"
        bind:value={qty}
        on:keyup={handleEnterKey}
        on:blur={updateQty}
      /></td
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
