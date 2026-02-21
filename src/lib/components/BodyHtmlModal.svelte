<script lang="ts">
  import { createEventDispatcher, tick } from "svelte";

  export let open = false;
  export let value = "";
  export let title = "Edit Description HTML";
  export let showRegenerate = false;
  export let showPrompt = false;

  const dispatch = createEventDispatcher();

  let htmlValue = "";
  let contentEl: HTMLDivElement | null = null;
  let lastValue = "";

  function prettyPrintHtml(html: string) {
    const clean = (html || "")
      .replace(/\r\n/g, "\n")
      .replace(/>\s+</g, ">\n<")
      .trim();
    const lines = clean.split("\n");
    let indent = 0;
    const out: string[] = [];
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.match(/^<\/\w/)) {
        indent = Math.max(0, indent - 1);
      }
      out.push(`${"  ".repeat(indent)}${trimmed}`);
      const isOpeningTag = trimmed.match(/^<\w([^>]*)[^/]>$/);
      const isSelfClosing = trimmed.match(/\/>$/);
      if (isOpeningTag && !isSelfClosing) {
        indent += 1;
      }
    });
    return out.join("\n");
  }

  $: if (open && value !== lastValue) {
    htmlValue = prettyPrintHtml(value || "");
    lastValue = value;
    tick().then(() => {
      if (contentEl) contentEl.innerHTML = htmlValue;
    });
  }

  function handleTextInput(e: Event) {
    const target = e.target as HTMLTextAreaElement;
    htmlValue = target.value;
    if (contentEl && contentEl.innerHTML !== htmlValue) {
      contentEl.innerHTML = htmlValue;
    }
  }

  function handleContentInput(e: Event) {
    const target = e.currentTarget as HTMLDivElement;
    htmlValue = target.innerHTML;
  }

  function handleSave() {
    dispatch("save", { value: htmlValue });
    lastValue = htmlValue;
  }

  function handleCancel() {
    dispatch("cancel");
    lastValue = value;
  }

  $: if (!open) {
    lastValue = value;
  }
</script>

{#if open}
  <div class="modal-backdrop">
    <div class="modal body-modal">
      <div class="modal-header">
        <h3 class="modal-title">{title}</h3>
        <div class="modal-tools">
          {#if showRegenerate}
            <button class="btn-tool" on:click={() => dispatch("regenerate")}
              >↻ Desc</button
            >
          {/if}
          {#if showPrompt}
            <button class="btn-tool" on:click={() => dispatch("editPrompt")}
              >✎</button
            >
          {/if}
        </div>
      </div>
      <div class="body-modal-grid">
        <div class="body-pane">
          <div class="pane-title">HTML</div>
          <textarea
            class="body-textarea"
            bind:value={htmlValue}
            on:input={handleTextInput}
          ></textarea>
        </div>
        <div class="body-pane">
          <div class="pane-title">Preview / Edit</div>
          <div
            class="body-contenteditable"
            contenteditable
            bind:this={contentEl}
            on:input={handleContentInput}
          ></div>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel" on:click={handleCancel}>Cancel</button>
        <button class="btn-save" on:click={handleSave}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 150;
  }
  .modal {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    width: 100%;
    max-width: 960px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .modal-title {
    font-weight: 600;
    font-size: 1.1rem;
  }
  .modal-tools {
    display: flex;
    gap: 0.5rem;
  }
  .btn-tool {
    padding: 0.4rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: white;
    cursor: pointer;
  }
  .body-modal-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-top: 1rem;
  }
  .body-pane {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pane-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #6b7280;
  }
  .body-textarea {
    min-height: 320px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
  }
  .body-contenteditable {
    min-height: 320px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem;
    background: #fafafa;
    overflow: auto;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
    gap: 0.5rem;
  }
  .btn-cancel {
    padding: 0.5rem 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: white;
    cursor: pointer;
  }
  .btn-save {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: #2563eb;
    color: white;
    border: none;
    cursor: pointer;
  }
</style>
