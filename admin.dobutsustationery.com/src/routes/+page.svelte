<script lang="ts">
  import BarcodeScanner from "$lib/BarcodeScanner.svelte";
  import Signin from "$lib/Signin.svelte";

  function user(e: CustomEvent) {
    console.log("CUSTOM EVENT: ", e);
  }

  import { auth, googleAuthProvider } from "$lib/firebase";
  import { get } from "$lib/http";

  let result = "No scan yet";
  let hsCode = "39199080";
  let qty = "10";
  let dirty = true;
  let imageItems: any[] = [];
  async function barcode(e: CustomEvent) {
    console.log(`New Result: ${e}`, e);
    newResult(e.detail);
  }
  function blur() {
    newResult(result);
  }
  async function newResult(r: string) {
    result = r;
    const imgSearch = `https://customsearch.googleapis.com/customsearch/v1?q=${result}&searchType=image&key=AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q&cx=b57eec92c05d54096`;

    const images = await get(imgSearch);
    console.log({ images });
    imageItems = images.items;
    dataURL = "";
    selectedPic = 0;
  }

  let dataURL: string = "";
  function snapshot(e: CustomEvent) {
    dataURL = e.detail;
  }

  const imageSearchKey = "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q";
  const picWidth = 140;
  let selectedPic = 0;
  function chooseImage(i: number) {
    return () => {
      selectedPic = i;
      dropdownOpen = "";
      dataURL = "";
      dirty = true;
    };
  }
  let dropdownOpen = "";
  function toggleDropdown() {
    if (dropdownOpen) {
      dropdownOpen = "";
    } else {
      dropdownOpen = "ddopen";
    }
  }

  $: if (result) {
    dirty = true;
  }
  $: if (qty) {
    dirty = true;
  }
  $: if (hsCode) {
    dirty = true;
  }

  function save() {
    dirty = false;
  }
</script>

<div class="column fullheight">
  <h1>Inventory</h1>
  <BarcodeScanner on:barcode={barcode} on:snapshot={snapshot} />
  <div class="{dropdownOpen} dropdown">
    {#if imageItems.length > 0}
      {#if dataURL}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <img
          width={picWidth}
          src={dataURL}
          alt="sr"
          on:click={toggleDropdown}
        />
      {:else}
        <!-- svelte-ignore a11y-click-events-have-key-events -->
        <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
        <img
          width={picWidth}
          src={imageItems[selectedPic].link}
          alt="sr"
          on:click={toggleDropdown}
        />
      {/if}
      <div class="dropdown-content">
        {#each imageItems as imageInfo, i (imageInfo.link)}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
          <img
            on:click={chooseImage(i)}
            width={picWidth}
            src={imageInfo.link}
            alt="sr"
          />
        {/each}
      </div>
    {/if}
  </div>
  <label>
    JAN Code:
    <input type="text" bind:value={result} on:blur={blur} />
  </label>
  <label>
    HS Code:
    <input type="text" bind:value={hsCode}/>
  </label>
  <label>
    Quantity:
    <input type="text" bind:value={qty}/>
  </label>
  {#if dirty}
     <button on:click={save}>Save</button>
  {/if}
  <div class="filler" />
  <div>
    <Signin {auth} {googleAuthProvider} on:user_changed={user} />
  </div>
</div>

<style>
  div {
    display: flex;
    flex-direction: row;
    margin: 0.5em;
  }
  .column {
    flex-direction: column;
  }
  .row {
    flex-direction: row;
  }
  .filler {
    flex-grow: 1;
  }
  .dropdown {
    position: relative;
    display: inline-block;
  }

  .dropdown-content {
    display: none;
    position: absolute;
    background-color: #f9f9f9;
    min-width: 160px;
    box-shadow: 0px 8px 16px 0px rgba(0, 0, 0, 0.2);
    z-index: 1;
  }

  .ddopen .dropdown-content {
    display: block;
  }

  .desc {
    padding: 15px;
    text-align: center;
  }

  .fullheight {
    height: 100%;
  }
</style>
