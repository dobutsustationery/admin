<script lang="ts">
import { createEventDispatcher } from "svelte";
import { store } from "./store";

export let id = "";
export let label: string | null = null;
export let value: string | null = "";
export let barcode: string | null = null;
let state = store.getState();

const dispatchEvent = createEventDispatcher();
let options: string[] = [];
$: if ($store) {
  state = store.getState();
  options = state.names.nameIdToNames[id].filter(
    (n) => state.inventory.idToItem[`${barcode}${n}`] !== undefined,
  );
}

function getLabel() {
  return label === null ? id : label;
}

$: if (value) {
  dispatchEvent("value", value);
}
</script>

{#if options.length > 0}
  <label
    >{getLabel()}
    <select bind:value>
      {#each options as name}
        <option>{name}</option>
      {/each}
    </select>
  </label>
{/if}
