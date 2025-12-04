<script lang="ts">
import { auth, firestore, googleAuthProvider } from "$lib/firebase";
  import { archive_inventory } from "$lib/inventory";
  import { broadcast } from "$lib/redux-firestore";
  import Signin, { type User } from "$lib/Signin.svelte";
  import { store } from "$lib/store";

  let ids: string[] = [];
  let state = store.getState();

  $: if ($store) {
    state = store.getState();
    ids = Object.keys(state.inventory.archivedInventoryState);
  }

  let me: User = { signedIn: false };

  function user(e: CustomEvent) {
    me = e.detail;
  }

  let archiveName = "";
  function archive() {
    if (archiveName && me.signedIn) {
      broadcast(firestore, me.uid, archive_inventory({ archiveName }));
      archiveName = "";
    }
  }
</script>

<h1>Archives</h1>

<ul>
  {#each ids as id}
    <li>{id}</li>
  {/each}
</ul>

<input type="text" bind:value={archiveName} placeholder="Name Archive" />
<button on:click={archive}> Add Archive </button>

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
