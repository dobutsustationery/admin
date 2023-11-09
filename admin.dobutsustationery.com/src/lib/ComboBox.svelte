<script lang="ts">
  import { firestore } from "./firebase";
  import { user } from "./globals";
  import { create_name } from "./names";
  import { broadcast } from "./redux-firestore";
  import { store } from "./store";

  export let id: string = "";
  export let value: string = "";
  let state = store.getState();
  $: if ($store) {
    state = store.getState();
  }

  function recordValue() {
    if (!state.names.nameIdToNames[id] || state.names.nameIdToNames[id].indexOf(value) === -1) {
      console.log({state, index:state.names.nameIdToNames[id]?.indexOf(value), value, id  })
        broadcast(firestore, $user.uid, create_name({id, name: value}));
    }
  }
</script>

<label
  >{id} <input type="text" name="myFruit" id="myFruit" list={id} bind:value on:blur={recordValue}/>
  <datalist {id}>
    {#each state.names.nameIdToNames[id] || [] as name}
      <option>{name}</option>
    {/each}
  </datalist>
</label>
