<script lang="ts">
  export let value: any;
  export let label: string = "";
  export let expanded = false;
  export let depth = 0;

  let isObject = false;
  let isArray = false;
  let summary = "";
  let keys: string[] = [];

  $: {
    isObject = value !== null && typeof value === 'object';
    isArray = Array.isArray(value);
    
    if (isObject) {
         keys = Object.keys(value);
         if (isArray) {
             summary = `[${value.length}]`;
         } else {
             summary = `{${keys.length}}`;
         }
    } else {
        if (typeof value === 'string') {
             summary = `"${value}"`;
        } else {
             summary = String(value);
        }
    }
  }

  function toggle() {
    expanded = !expanded;
  }
</script>

<div class="tree-node" style="padding-left: {depth > 0 ? 10 : 0}px">
  {#if isObject && keys.length > 0}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="header clickable" on:click={toggle} role="button" tabindex="0">
      <span class="arrow" class:expanded>▶</span>
      {#if label}<span class="label">{label}:</span>{/if}
      <span class="summary type-{typeof value}">{Array.isArray(value) ? 'Array' : 'Object'} {summary}</span>
    </div>
    
    {#if expanded}
      <div class="children">
        {#each keys as key}
          <svelte:self 
             value={value[key]} 
             label={key} 
             depth={depth + 1} 
             expanded={false} 
          />
        {/each}
      </div>
    {/if}

  {:else}
    <div class="header">
      {#if label}<span class="label">{label}:</span>{/if}
      <span class="value type-{typeof value}">
        {#if typeof value === 'string'}
          "{value}"
        {:else}
          {String(value)}
        {/if}
      </span>
    </div>
  {/if}
</div>

<style>
  .tree-node {
    font-family: monospace;
    font-size: 13px;
    line-height: 1.5;
    color: #333;
  }
  
  .header {
    display: flex;
    align-items: flex-start;
  }
  
  .clickable {
    cursor: pointer;
    user-select: none;
  }
  
  .clickable:hover {
    background-color: rgba(0,0,0,0.05);
  }

  .arrow {
    display: inline-block;
    width: 14px;
    font-size: 10px;
    color: #666;
    transition: transform 0.1s;
    margin-right: 4px;
  }
  
  .arrow.expanded {
    transform: rotate(90deg);
  }

  .label {
    color: #881391; /* Purple for keys */
    margin-right: 5px;
  }
  
  .summary {
    color: #666;
    font-style: italic;
  }

  .value.type-string {
    color: #c41a16; /* Red for strings */
    word-break: break-all;
  }
  
  .value.type-number {
    color: #1c00cf; /* Blue for numbers */
  }
  
  .value.type-boolean {
    color: #0d22aa; /* Dark blue for booleans */
    font-weight: bold;
  }
  
  .children {
    border-left: 1px solid #eee;
    margin-left: 5px;
  }
</style>
