<script lang="ts">
  import ComboBox from "./ComboBox.svelte";
  import { firestore } from "./firebase";
  import { user } from "./globals";
  import { type Item, update_field } from "./inventory";
  import { broadcast } from "./redux-firestore";
  import { store } from "./store";

    export let key: string = "";
    export let row: number = -1;

    let state = store.getState();
    let item: Item | null = null;
    $: if ($store) {
        state = store.getState();
        item = {...state.inventory.idToItem[key]};
    }

    function updateField(key: string, item: Item, field: keyof Item) {
        return (e: any) => {
            const to = e.detail || e.target.value;
            const from = item[field];
            if (to !== null) {
                broadcast(firestore, $user.uid, update_field({ id: key, field, to, from }))
            }
        }
    }
    function handleEnterKey(e: KeyboardEvent) {
        if (e.key === 'Enter') {
            const target = e.target as HTMLInputElement;
            target.blur();
        }
    }
</script>

{#if key && item !== null}
    <tr class={row % 2 === 0 ? "even" : "odd"}>
        <td>{item.janCode}</td>
        <td>{item.subtype}</td>
        <td><input class="description" type="text" on:blur={updateField(key, item, "description")} on:keyup={handleEnterKey} value={item.description}></td>
        <td><img alt="snapshot" height="75" src="{item.image}"/></td>
        <td><ComboBox label="" value={item.hsCode} id="HSCode" on:value={updateField(key, item, "hsCode")}/></td>
        <td><input class="pieces" type="number" on:blur={updateField(key, item, "pieces")} on:keyup={handleEnterKey} value={item.pieces}></td>
        <td><input class="qty" type="number" on:blur={updateField(key, item, "qty")} on:keyup={handleEnterKey} value={item.qty}></td>
        <td class="total">{item.pieces > 0 ? item.pieces*item.qty : item.qty}</td>
    </tr>
{/if}

<style>
    .odd {
        background-color: bisque;
    }

    .total {
        text-align: right;
    }

    td {
        padding: 0.3em;
    }

    input[type="number"] {
        width: 4em;
        text-align: right;
        background-color: #fff0;
        border: none;
    }

    .description {
        width: 40vw;
        border: none;
        padding: 0.4em;
        background-color: #fff0;
    }
</style>
