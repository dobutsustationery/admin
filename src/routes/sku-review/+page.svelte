<script lang="ts">
  import { store } from "$lib/store";
  import { update_item, type Item } from "$lib/inventory";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";

  let showAll = false;
  let itemsMissingData: { key: string; item: Item; missing: string[] }[] = [];

  $: {
    const inv = $store.inventory.idToItem;
    itemsMissingData = [];
    if (inv) {
      for (const key in inv) {
        const item = inv[key];
        const missing: string[] = [];
        if (!item.price) missing.push("Price");
        if (!item.weight) missing.push("Weight");
        if (!item.image) missing.push("Image");
        
        // Filter out items with 0 qty if we are not showing all
        if (!showAll && (item.qty || 0) <= 0) continue;

        if (missing.length > 0) {
          itemsMissingData.push({ key, item, missing });
        }
      }
      // Sort by creationDate desc
      itemsMissingData.sort((a, b) => b.item.creationDate.localeCompare(a.item.creationDate));
    }
  }

  function saveItem(key: string, item: Item, priceStr: string, weightStr: string) {
    const price = parseFloat(priceStr);
    const weight = parseFloat(weightStr);
    
    // Create a copy to update
    const updatedItem = { ...item };
    if (!isNaN(price)) updatedItem.price = price;
    if (!isNaN(weight)) updatedItem.weight = weight;

    if ($user && $user.uid) {
      broadcast(firestore, $user.uid, update_item({ id: key, item: updatedItem }));
    }
  }
</script>

<div class="container">
  <h1>SKU Review</h1>
  <p>Items missing Price, Weight, or Image.</p>
  
  <label>
    <input type="checkbox" bind:checked={showAll}> Show out-of-stock items
  </label>

  {#if itemsMissingData.length === 0}
    <div class="empty">All set! No items missing data.</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Image</th>
          <th>JAN</th>
          <th>Subtype</th>
          <th>Description</th>
          <th>Stock</th>
          <th>Missing</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {#each itemsMissingData as { key, item, missing } (key)}
          <tr>
            <td>
              {#if item.image}
                <img src={item.image} alt="Product" class="thumb"/>
              {:else}
                <span class="no-img">No Img</span>
              {/if}
            </td>
            <td>{item.janCode}</td>
            <td>{item.subtype}</td>
            <td class="desc">{item.description}</td>
            <td>{item.qty}</td>
            <td>
              {#each missing as m}
                <span class="badge">{m}</span>
              {/each}
            </td>
            <td>
               <div class="inputs">
                 <input type="number" placeholder="Price" value={item.price || ''} 
                   on:change={(e) => saveItem(key, item, e.currentTarget.value, item.weight?.toString() || '')}
                 />
                 <input type="number" placeholder="Weight (g)" value={item.weight || ''}
                    on:change={(e) => saveItem(key, item, item.price?.toString() || '', e.currentTarget.value)}
                 />
               </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .container {
    padding: 2rem;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 1rem;
  }
  th, td {
    border: 1px solid #eee;
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  .thumb {
    width: 50px;
    height: 50px;
    object-fit: cover;
  }
  .no-img {
    display: inline-block;
    width: 50px;
    height: 50px;
    background: #f3f4f6;
    color: #9ca3af;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
  }
  .badge {
    background: #fee2e2;
    color: #991b1b;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-right: 4px;
  }
  .inputs {
    display: flex;
    gap: 0.5rem;
  }
  input {
    width: 80px;
    padding: 4px;
    border: 1px solid #ccc;
    border-radius: 4px;
  }
  .empty {
    margin-top: 2rem;
    color: #166534;
    font-weight: bold;
  }
</style>
