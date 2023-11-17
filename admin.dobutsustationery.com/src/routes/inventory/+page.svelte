<script lang="ts">
  import InventoryRow from "$lib/InventoryRow.svelte";
  import { store } from "$lib/store";

  let state = store.getState();

  let itemKeys: string[] = [];
  $: if ($store) {
    state = store.getState();
    itemKeys = Object.keys(state.inventory.idToItem);
  }
</script>

<table>
  <thead><tr>
    <th>JAN Code</th>
    <th>Subtype</th>
    <th>Description</th>
    <th>Snapshot</th>
    <th>HS Code</th>
    <th>Pieces</th>
    <th>Quantity</th>
    <th>Total</th>
  </tr></thead>
{#each itemKeys as k,i}
    <InventoryRow key={k} row={i}/>
{/each}
</table>
