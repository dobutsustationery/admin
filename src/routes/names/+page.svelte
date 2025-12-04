<script lang="ts">
  import ComboBox from "$lib/ComboBox.svelte";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase";
  import { create_name, remove_name } from "$lib/names";
  import { broadcast, watchBroadcastActions } from "$lib/redux-firestore";
  import { store } from "$lib/store";
  import Signin, { type User } from "$lib/Signin.svelte";
  import type { AnyAction } from "@reduxjs/toolkit";

  let id = "";
  let name = "";
  let ids: string[] = [];
  let state = store.getState();

  $: if ($store) {
    state = store.getState();
    ids = Object.keys(state.names.nameIdToNames);
  }

  let me: User = { signedIn: false };
  function newName() {
    if (me.signedIn) {
      broadcast(firestore, me.uid, create_name({ id, name }));
    }
  }

  function removeName(id: string, name: string) {
    return () => {
      if (me.signedIn) {
        broadcast(firestore, me.uid, remove_name({ id, name }));
      }
    };
  }

  function user(e: CustomEvent) {
    me = e.detail;
  }
</script>

<h1>Recently Used Names and Codes</h1>

<label
  >ID:
  <input type="text" bind:value={id} />
</label>
<label
  >Value:
  <input type="text" bind:value={name} />
</label>
<button on:click={newName}>Add</button>
<ul>
  {#each ids as id}
    <li>
      {id}
      <ul>
        {#each state.names.nameIdToNames[id] as name}
          <li><button on:click={removeName(id, name)}>x</button> {name}</li>
        {/each}
      </ul>
    </li>
  {/each}
</ul>

{#each ids as id}
  <ComboBox {id} />
{/each}

<div>
  <Signin {auth} {googleAuthProvider} on:user_changed={user} />
</div>
