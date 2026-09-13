<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let id: string;
  export let label: string;
  export let files: { id: string; name: string }[] = [];
  export let value = "";

  const dispatch = createEventDispatcher<{ select: string }>();
  let query = "";
  let syncedValue = "";
  $: nameCounts = files.reduce((counts, file) => {
    counts.set(file.name, (counts.get(file.name) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  $: options = files.map((file) => ({
    id: file.id,
    label:
      (nameCounts.get(file.name) || 0) > 1
        ? `${file.name} — ${file.id}`
        : file.name,
  }));
  // Reflect resumed reports, direct URL entry, and refreshed file names.
  $: selectedLabel =
    options.find((option) => option.id === value)?.label || value;
  $: if (value !== syncedValue || (value && query !== selectedLabel)) {
    query = selectedLabel;
    syncedValue = value;
  }

  function choose(event: Event) {
    query = (event.currentTarget as HTMLInputElement).value;
    const match = options.find((option) => option.label === query);
    // A partial search must not leave the old source selected.
    value = match?.id || "";
    syncedValue = value;
    if (match) dispatch("select", value);
  }
</script>

<label for={id}>{label}</label>
<input
  {id}
  list={id + "-files"}
  value={query}
  on:input={choose}
  placeholder="Type a spreadsheet name…"
  autocomplete="off"
/>
<datalist id={id + "-files"}>
  {#each options as option}<option value={option.label}></option>{/each}
</datalist>

<style>
  label {
    display: block;
    margin: 0.5rem 0.5rem 0.4rem;
    font-size: 0.85rem;
    font-weight: 600;
  }
  input {
    box-sizing: border-box;
    min-height: 40px;
    width: calc(100% - 1rem);
    margin: 0 0.5rem 0.5rem;
    padding: 0.6rem 0.75rem;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    font: inherit;
    font-size: 0.85rem;
    background: white;
    color: #1e293b;
  }
  input:focus-visible {
    outline: 2px solid var(--primary-color, #0056b3);
    outline-offset: 2px;
  }
  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
