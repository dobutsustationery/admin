<script lang="ts">
  import ComboBox from "./ComboBox.svelte";
import { update_item, type Item } from "./inventory";
  import { store } from "./store";

    export let key: string = "";
    export let row: number = -1;

    let state = store.getState();
    let item: Item | null = null;
    $: if ($store) {
        state = store.getState();
        item = {...state.inventory.idToItem[key]};
        if (!description) {
            description = item.description;
        }
        if (!subtype) {
            subtype = item.subtype;
        }
    }

    let subtype = "";
    let description = "";
    function describeItem(key: string, item: Item) {
        return () => {
            if (description !== item.description) {
                console.log(`update ${key} description to ${description} from ${item.description}`)
                item.description = description;
                store.dispatch(update_item({ id: key, item }))
            }
        }
    }
</script>

{#if key && item !== null}
    <tr class={row % 2 === 0 ? "even" : "odd"}>
        <td>{item.janCode}</td>
        <!-- 
        <td><ComboBox bind:value={subtype} id="Subtype"/></td>
        <td><input type="text" on:blur={describeItem(key, item)} bind:value={description}></td>
        -->
        <td>{subtype}</td>
        <td>{description}</td>
        <td><img alt="snapshot" height="75" src="{item.image}"/></td>
        <td>{item.hsCode}</td>
        <td>{item.pieces}</td>
        <td>{item.qty}</td>
        <td>{item.pieces*item.qty}</td>
    </tr>
{/if}

<style>
    .odd {
        background-color: bisque;
    }

    td {
        padding: 0.3em;
    }
</style>