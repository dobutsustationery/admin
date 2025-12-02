<script lang="ts">
  import { auth, googleAuthProvider } from "$lib/firebase";
  import { store } from "$lib/store";
  import { Signin, type User } from "@ourway/svelte-firebase-auth";
  import OrderRow from "$lib/OrderRow.svelte";
  import { hide_archive, make_sales, type OrderInfo } from "$lib/inventory";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";

  let ids: string[] = [];
  let sales: string[] = [];
  let hidden: string[] = [];
  let excludedDates: { [k: string]: boolean } = {};
  let uniqueDates: string[] = [];

  $: if ($store) {
    ids = Object.keys($store.inventory.archivedInventoryState);
    sales = Object.keys($store.inventory.salesEvents);
  }

  let me: User = { signedIn: false };

  let salesData: OrderInfo | undefined = undefined;

  function viewSales(id: string) {
    // Logic to view sales for the given archive ID
    console.log(`Viewing sales for archive: ${id}`);
    salesData = $store.inventory.salesEvents[id];
    const creationDates: { [k: string]: boolean } = {};
    for (const item in salesData.items) {
      const itemKey = salesData.items[item].itemKey;
      const seenDate =
        $store.inventory.archivedInventoryState[id].idToItem[itemKey]
          .creationDate;
      creationDates[seenDate] = true;
    }
    uniqueDates = Object.keys(creationDates);
    excludedDates = {};
  }

  function createSales(archiveName: string) {
    // Logic to create sales for the given archive ID
    console.log(`Creating sales for archive: ${archiveName}`);
    if (archiveName && me.signedIn) {
      broadcast(
        firestore,
        me.uid,
        make_sales({ archiveName, date: new Date() }),
      );
    }
  }

  function hideArchive(archiveName: string) {
    if (archiveName && me.signedIn) {
      broadcast(firestore, me.uid, hide_archive({ archiveName }));
    }
  }

  function makeCSV() {
    const header = [
      "Creation Dates",
      "Snapshot",
      "Description",
      "JAN Code",
      "Subtype",
      "Quantity Sold",
    ].join(",");
    const rows = salesData?.items
      .filter((k) => {
        const item =
          $store.inventory.archivedInventoryState[salesData?.product || ""]
            .idToItem[k.itemKey];
        return !excludedDates[item.creationDate];
      })
      .map((k) => {
        const item =
          $store.inventory.archivedInventoryState[salesData?.product || ""]
            .idToItem[k.itemKey];
        return [
          `"${item.creationDate}"`,
          `"${item.image}"`,
          `"${item.description}"`,
          `"${item.janCode}"`,
          `"${item.subtype}"`,
          k.qty,
        ].join(",");
      })
      .join("\n");
    return `${header}\n${rows}`;
  }
  function downloadCSV() {
    if (salesData) {
      const csvContent = "data:text/csv;charset=utf-8," + makeCSV();
      const encodedUri = encodeURI(csvContent);
      const link = document.createElement("a");
      link.setAttribute("href", encodedUri);
      link.setAttribute("download", `${salesData.product}.csv`);
      document.body.appendChild(link);
      link.click();
    }
  }

  function user(e: CustomEvent) {
    me = e.detail;
  }
</script>

<h1>Create and view event sales</h1>

<h1>Available Archives</h1>

<table>
  <thead>
    <tr>
      <th>Date</th>
      <th>Archive Name</th>
      <th>Actions</th>
    </tr>
  </thead>
  {#each ids as id}
    <tr>
      <td>{$store.inventory.archivedInventoryDate[id]}</td>
      <td>{id}</td>
      <td>
        {#if sales.includes(id) || hidden.includes(id)}
          <button on:click={() => viewSales(id)}>View</button>
        {:else}
          <button on:click={() => createSales(id)}>Create Sales</button>
          <button on:click={() => hideArchive(id)}>Hide Archive</button>
        {/if}
      </td>
    </tr>
  {/each}
</table>

{#if salesData}
  <h2>Sales Data for {salesData.product}</h2>
  <p>Exclude items created on:</p>
  {#each uniqueDates as date}
    <label>
      <input
        type="checkbox"
        checked={excludedDates[date]}
        on:change={() => {
          excludedDates[date] = !excludedDates[date];
          excludedDates = { ...excludedDates };
        }}
      />{date}
    </label>
  {/each}
  <table>
    <thead
      ><tr>
        <th>Dates</th>
        <th>Snapshot</th>
        <th>Description</th>
        <th>JAN Code</th>
        <th>Subtype</th>
        <th>Quantity Sold</th>
      </tr></thead
    >
    {#if salesData !== undefined}
      {#each salesData.items as k, i (k.itemKey)}
        {#if !excludedDates[$store.inventory.archivedInventoryState[salesData.product || ""].idToItem[k.itemKey].creationDate]}
          <OrderRow
            showdates={true}
            key={k.itemKey}
            row={i}
            qty={k.qty}
            immutable={true}
          />
        {/if}
      {/each}
    {/if}
  </table>
  <button on:click={downloadCSV}> Download CSV </button>
{/if}

<div>
  <Signin {auth} {googleAuthProvider} on:user_changed={user} />
</div>

<style>
  table {
    border: 1px solid black;
    border-collapse: collapse;
    margin: 2em;
  }

  th,
  td {
    border: 1px solid black;
    padding: 5px;
  }

  th {
    background-color: #f2f2f2;
  }
  label {
    white-space: nowrap;
  }
</style>
