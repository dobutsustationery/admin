<script lang="ts">
  import { page } from "$app/stores";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase";
  import { hide_archive, make_sales, type OrderInfo } from "$lib/inventory";
  import OrderRow from "$lib/OrderRow.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import Signin, { type User } from "$lib/Signin.svelte";
  import { store } from "$lib/store";

  let me: User = { signedIn: false };

  $: itemKey = $page.url.searchParams.get("itemKey");

  function user(e: CustomEvent) {
    me = e.detail;
  }
</script>

{#if itemKey}
  <h1>Item History for {itemKey}</h1>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Action</th>
      </tr>
    </thead>
    {#each $store.inventory.idToHistory[itemKey] || [] as history}
      <tr>
        <td>{history.date}</td>
        <td>{history.desc}</td>
      </tr>
    {/each}
  </table>
{:else}
  <h1>Loading...</h1>
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

</style>
