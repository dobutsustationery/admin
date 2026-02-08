<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase";
  import { hide_archive, make_sales, type OrderInfo } from "$lib/inventory";
  import OrderRow from "$lib/OrderRow.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import Signin, { type User } from "$lib/Signin.svelte";
  import { store } from "$lib/store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";

  let me: User = { signedIn: false };
  let searchQuery = "";

  $: itemKey = $page.url.searchParams.get("itemKey");
  $: currentItem = itemKey && $store.inventory?.idToItem ? $store.inventory.idToItem[itemKey] : null;

  $: allMatches = (searchQuery.length > 2 && $store.inventory?.idToItem
      ? Object.entries($store.inventory.idToItem)
          .filter(([key, item]: [string, any]) => {
              const q = searchQuery.toLowerCase();
              return (item.janCode && item.janCode.includes(q)) || 
                     (item.description && item.description.toLowerCase().includes(q)) ||
                     key.toLowerCase().includes(q);
          })
      : []) as [string, any][];

  $: searchResults = allMatches.slice(0, 100);
  $: truncatedCount = Math.max(0, allMatches.length - 100);

  function user(e: CustomEvent) {
    me = e.detail;
  }
  
  function selectItem(key: string) {
      goto(`/itemhistory?itemKey=${key}`);
      searchQuery = ""; // Clear search or keep it? Clearing feels cleaner once selected.
  }
</script>

<div class="page-container">
    <div class="search-section">
        <input 
            type="text" 
            placeholder="Search JAN or Title..." 
            bind:value={searchQuery}
            class="search-input"
        />
        {#if searchResults.length > 0}
            <div class="search-results">
                {#each searchResults as [key, item]}
                    <button class="result-item" on:click={() => selectItem(key)}>
                        <div class="result-thumb">
                            {#if item.image}
                                <ImageThumbnail src={item.image} alt={item.description} width="30px" height="30px" />
                            {/if}
                        </div>
                        <div class="result-info">
                            <span class="result-jan">{item.janCode}</span>
                            <span class="result-desc">{item.description}</span>
                        </div>
                    </button>
                {/each}
                {#if truncatedCount > 0}
                    <div class="result-truncated">
                        +{truncatedCount} more...
                    </div>
                {/if}
            </div>
        {/if}
    </div>

    {#if itemKey}
      <div class="header-section">
          {#if currentItem && currentItem.image}
              <div class="main-thumb">
                  <ImageThumbnail src={currentItem.image} alt={currentItem.description} width="100px" height="100px" />
              </div>
          {/if}
          <div class="title-info">
              <h1>Item History</h1>
              {#if currentItem}
                  <h2 class="subtitle">{currentItem.description}</h2>
                  <div class="meta">
                      <span class="jan">{currentItem.janCode}</span>
                      {#if currentItem.subtype}<span class="subtype">({currentItem.subtype})</span>{/if}
                  </div>
              {:else}
                  <h2 class="subtitle">{itemKey} (Item not found in current inventory)</h2>
              {/if}
          </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
            {#each [...($store.inventory.idToHistory[itemKey] || [])].reverse() as history}
              <tr>
                <td class="date-col">{history.date}</td>
                <td>{history.desc}</td>
              </tr>
            {/each}
        </tbody>
      </table>
    {:else}
      <div class="empty-state">
          <h1>Item History</h1>
          <p>Search for an item to view its history.</p>
      </div>
    {/if}

    <div class="auth-wrapper">
      <Signin {auth} {googleAuthProvider} on:user_changed={user} />
    </div>
</div>

<style>
  .page-container {
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
  }
  
  .search-section {
      position: relative;
      margin-bottom: 2rem;
  }
  
  .search-input {
      width: 100%;
      padding: 0.75rem;
      font-size: 1rem;
      border: 1px solid #ccc;
      border-radius: 4px;
  }
  
  .search-results {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: white;
      border: 1px solid #ccc;
      border-top: none;
      border-radius: 0 0 4px 4px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      z-index: 10;
      max-height: 300px;
      overflow-y: auto;
  }
  
  .result-item {
      display: flex;
      align-items: center;
      gap: 1rem;
      width: 100%;
      padding: 0.5rem 1rem;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      border-bottom: 1px solid #eee;
  }
  
  .result-item:hover {
      background: #f9f9f9;
  }
  
  .result-thumb { width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; background: #eee; }
  .result-info { display: flex; flex-direction: column; }
  .result-jan { font-weight: bold; font-size: 0.85rem; }
  .result-desc { font-size: 0.8rem; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; }

  .header-section {
      display: flex;
      gap: 1.5rem;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #eee;
  }
  
  .main-thumb {
      flex-shrink: 0;
  }
  
  .title-info h1 { margin: 0 0 0.5rem 0; font-size: 1.5rem; }
  .subtitle { margin: 0 0 0.25rem 0; font-size: 1.1rem; color: #333; font-weight: normal; }
  .meta { color: #666; font-family: monospace; }

  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #eee;
  }

  th,
  td {
    border: 1px solid #eee;
    padding: 0.75rem;
    text-align: left;
    vertical-align: top;
  }

  th {
    background-color: #f9fafb;
    font-weight: 600;
  }
  
  .date-col {
      white-space: nowrap;
      color: #666;
      font-size: 0.9rem;
  }
  
  .result-truncated {
      padding: 0.5rem 1rem;
      text-align: center;
      color: #666;
      font-size: 0.85rem;
      background: #f9f9f9;
      border-top: 1px solid #eee;
  }
  
  .empty-state { text-align: center; color: #666; margin-top: 4rem; }
  .auth-wrapper { margin-top: 2rem; text-align: right; }
</style>
