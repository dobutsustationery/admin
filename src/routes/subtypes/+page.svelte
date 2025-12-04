<script lang="ts">
  import { auth, googleAuthProvider } from "$lib/firebase";
  import Signin, { type User } from "$lib/Signin.svelte";
  import SubtypeRow from "$lib/SubtypeRow.svelte";
  import { store } from "$lib/store";

  let ids: string[] = [];
  let codes: string[] = [];
  let state = store.getState();

  let janCodesToSubtypes: { [key: string]: string[] } = {};

  $: if ($store) {
    console.log("State upated; refresh...");
    state = store.getState();
    ids = Object.keys(state.inventory.idToItem).filter(
      (x) => state.inventory.idToItem[x].subtype !== "",
    );
    janCodesToSubtypes = {};
    for (const code of ids) {
      const janCode = state.inventory.idToItem[code].janCode;
      if (janCodesToSubtypes[janCode] === undefined) {
        janCodesToSubtypes[janCode] = [];
        if (state.inventory.idToItem[janCode]) {
          janCodesToSubtypes[janCode].push("");
        }
      }
      janCodesToSubtypes[janCode].push(state.inventory.idToItem[code].subtype);
    }
    codes = Object.keys(janCodesToSubtypes);
  }

  let me: User = { signedIn: false };

  function user(e: CustomEvent) {
    me = e.detail;
  }
</script>

<h1>Items with Subtypes</h1>

{#each codes as code}
  <table>
    <caption>
      {code}
    </caption>
    <thead>
      <tr>
        <th>Image</th>
        <th>Subtype</th>
        <th>HS Code</th>
        <th>Description</th>
      </tr>
    </thead>
    {#each janCodesToSubtypes[code] as subtype}
      <SubtypeRow {code} {subtype} otherTypes={janCodesToSubtypes[code]} />
    {/each}
  </table>
{/each}

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
