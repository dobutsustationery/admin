<script lang="ts">
  import substrings from "common-substrings";
  import { get } from "$lib/http";
  import ComboBox from "./ComboBox.svelte";
  import { firestore } from "./firebase";
  import { user } from "$lib/user-store";
  import {
    type Item,
    itemsLookIdentical,
    rename_subtype,
    update_field,
  } from "./inventory";
  import { broadcast } from "./redux-firestore";
  import { store } from "./store";

  export let code: string = "";
  export let subtype: string = "";
  export let otherTypes: string[] = [];

  const key = `${code}${subtype}`;
  let state = store.getState();
  let item: Item | null = null;
  let matched = true;
  $: if ($store) {
    state = store.getState();
    const sourceItem = state.inventory.idToItem[key];
    if (sourceItem) {
        item = { ...sourceItem };
        const links: { [k: string]: boolean } = {};
        imageItems = [];
        imageItems.push({
          link: item!.image,
          description: item!.description,
        });
        links[item!.image] = true;
        matched = true;
        for (const otherType of otherTypes) {
          const otherKey = `${code}${otherType}`;
          const otherItem = state.inventory.idToItem[otherKey];
          if (otherItem) {
             if (!links[otherItem.image]) {
                links[otherItem.image] = true;
                imageItems.push({
                  link: otherItem.image,
                  description: otherItem.description,
                });
             }
             if (!itemsLookIdentical(item!, otherItem)) {
                matched = false;
                console.log(`${key} and ${otherKey} do not match`, item, otherItem);
             } else {
                console.log(`${key} and ${otherKey} MATCH `, item, otherItem);
             }
          }
        }
        for (const newImage of newImageItems) {
          if (!links[newImage.link]) {
            links[newImage.link] = true;
            imageItems.push(newImage);
          }
        }
    } else {
        item = null;
    }
  }

  let imageSearchDone = false;
  async function newResult(janCode: string) {
    const imgSearch = `https://customsearch.googleapis.com/customsearch/v1?q=${janCode}&searchType=image&key=${import.meta.env.VITE_FIREBASE_API_KEY}&cx=b57eec92c05d54096`;
    console.log("imgSearch", imgSearch);

    const images = await get(imgSearch);
    newImageItems = images.items || [];
    if (newImageItems) {
      const stringArray = newImageItems.map((x: any) => x.title);
      const substrs = substrings(stringArray);
      substrs.sort((a, b) => b.weight - a.weight);
      console.log("newImageItems", newImageItems);
      imageItems = [...imageItems, ...newImageItems];
    }
    imageSearchDone = true;
  }

  function updateField(item: Item, field: keyof Item) {
    return (e: any) => {
      const to = e.detail || e.target.value;
      const from = item[field];
      if (to !== null && $user?.uid) {
        for (const otherType of otherTypes) {
          const otherKey = `${code}${otherType}`;
          broadcast(
            firestore,
            $user.uid,
            update_field({ id: otherKey, field, to, from }),
          );
        }
      }
    };
  }
  function handleEnterKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      const target = e.target as HTMLInputElement;
      target.blur();
    }
  }
  function updateSubtype(item: Item) {
    return (e: any) => {
      const itemKey = `${code}${item.subtype}`;
      const subtype = e.detail || e.target.value;
      if ($user?.uid) {
        broadcast(firestore, $user.uid, rename_subtype({ itemKey, subtype }));
      }
    };
  }

  let imageItems: { link: string; description: string }[] = [];
  let newImageItems: { link: string; description: string }[] = [];
  let selectedPic = 0;
  let dropdownOpen = "";
  function chooseImage(i: number) {
    return () => {
      const from = imageItems[selectedPic].link;
      selectedPic = i;
      if (selectedPic !== 0) {
        const to = imageItems[selectedPic].link;
        for (const otherType of otherTypes) {
          const otherKey = `${code}${otherType}`;
          if ($user?.uid) {
            broadcast(
              firestore,
              $user.uid,
              update_field({ id: otherKey, field: "image", to, from }),
            );
          }
        }
      }
      dropdownOpen = "";
    };
  }
  function toggleDropdown() {
    if (dropdownOpen) {
      dropdownOpen = "";
    } else {
      dropdownOpen = "ddopen";
      if (!imageSearchDone) {
        newResult(code);
      }
    }
  }
</script>

{#if key && item !== null}
  {@const item = state.inventory.idToItem[`${code}${subtype}`]}
  <tr>
    <td>
      <div class="{dropdownOpen} dropdown">
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <img
          src={item.image}
          alt={item.description}
          height="40px"
          on:click={toggleDropdown}
        />
        <div class="dropdown-content">
          {#each imageItems as imageInfo, i (imageInfo.link)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
            <img
              on:click={chooseImage(i)}
              height="40px"
              src={imageInfo.link}
              alt="sr"
            />
          {/each}
        </div>
      </div>
    </td>
    {#if matched}
      <td
        ><input
          class="hscode"
          type="text"
          on:blur={updateSubtype(item)}
          on:keyup={handleEnterKey}
          value={item.subtype}
        />
      </td>
    {:else}
      <td class="mismatch">
        {subtype}
      </td>
    {/if}
    <td
      ><input
        class="hscode"
        type="text"
        on:blur={updateField(item, "hsCode")}
        on:keyup={handleEnterKey}
        value={item.hsCode}
      />
    </td>
    <td
      ><input
        class="description"
        type="text"
        on:blur={updateField(item, "description")}
        on:keyup={handleEnterKey}
        value={item.description}
      />
    </td>
  </tr>
{/if}

<style>
  tr:nth-child(odd) {
    background-color: bisque;
  }

  td {
    padding: 0.3em;
  }

  .description {
    width: 40vw;
    border: none;
    padding: 0.4em;
    background-color: #fff0;
  }
  .hscode {
    border: none;
    padding: 0.4em;
    background-color: #fff0;
  }
  .dropdown {
    position: relative;
    display: inline-block;
  }

  .dropdown-content {
    display: none;
    position: absolute;
    background-color: #f9f9f9;
    padding: 0.5em;
    min-width: 160px;
    box-shadow: 0px 8px 16px 0px rgba(0, 0, 0, 0.2);
    z-index: 1;
  }
  .dropdown-content img {
    display: block;
  }

  .ddopen .dropdown-content {
    display: block;
  }
  .mismatch {
    background-color: #ffb3b3;
  }
</style>
