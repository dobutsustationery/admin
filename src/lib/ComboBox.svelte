<script lang="ts">
import { createEventDispatcher } from "svelte";
import { firestore } from "./firebase";
import { user } from "./globals";
import { create_name } from "./names";
import { broadcast } from "./redux-firestore";
import { store } from "./store";

export const id: string = "";
export const label: string | null = null;
export const value: string | null = "";
let state = store.getState();

const dispatchEvent = createEventDispatcher();
$: if ($store) {
  state = store.getState();
}

function getLabel() {
  return label === null ? id : label;
}

function recordValue() {
  if (value !== null) {
    if (
      !state.names.nameIdToNames[id] ||
      state.names.nameIdToNames[id].indexOf(value) === -1
    ) {
      broadcast(firestore, $user.uid, create_name({ id, name: value }));
    }
    dispatchEvent("value", value);
  }
}
function handleEnterKey(e: KeyboardEvent) {
  if (e.key === "Enter") {
    const target = e.target as HTMLInputElement;
    target.blur();
  }
}
</script>

<label
  >{getLabel()}
  <input
    size="12"
    type="text"
    list={id}
    bind:value
    on:blur={recordValue}
    on:keyup={handleEnterKey}
  />
  <datalist {id}>
    {#each state.names.nameIdToNames[id] || [] as name}
      <option>{name}</option>
    {/each}
  </datalist>
</label>
