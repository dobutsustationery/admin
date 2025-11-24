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
  <thead
    ><tr>
      <th>JAN Code</th>
      <th>Subtype</th>
      <th>Description</th>
      <th>Snapshot</th>
      <th>HS Code</th>
      <th>Pieces</th>
      <th>Quantity</th>
      <th>Shipped</th>
      <th>Total</th>
    </tr></thead
  >
  {#each itemKeys as k}
    {@const item = state.inventory.idToItem[k]}
    {@const pieces = item.pieces > 0 ? item.pieces : 1}
    {@const totalQty = pieces * item.qty - item.shipped}
    {#if totalQty > 0}
      <InventoryRow key={k} />
    {/if}
  {/each}
</table>
