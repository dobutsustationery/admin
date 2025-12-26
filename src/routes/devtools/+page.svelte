<script lang="ts">
  import { devtoolsStore, type LogEntry } from "$lib/devtools-middleware";
  import JsonTree from "$lib/components/JsonTree.svelte";
  import { fade } from "svelte/transition";

  let selectedEntry: LogEntry | null = null;
  let filter = "";

  // Grouping logic
  interface GroupedLog {
      id: number; // ID of the first item (parent)
      timestamp: number;
      parent: LogEntry;
      children: LogEntry[];
      expanded: boolean;
  }
  
  let groupedLogs: GroupedLog[] = [];

  // Preserve expanded state by ID (of the parent)
  let expandedState: Record<number, boolean> = {};

  $: logs = $devtoolsStore;
  $: {
      // Group logs by timestamp
      const tempGroups: GroupedLog[] = [];
      
      // Iterate through logs (newest first)
      for (const entry of logs) {
          const ts = entry.timestamp;
          
          if (tempGroups.length > 0 && Math.abs(tempGroups[tempGroups.length - 1].timestamp - ts) < 2) {
               // Same batch - Add to the LAST group added
               tempGroups[tempGroups.length - 1].children.push(entry);
          } else {
               // New Group
               tempGroups.push({
                   id: entry.id,
                   timestamp: ts,
                   parent: entry, // This is the "Main" action
                   children: [],
                   expanded: !!expandedState[entry.id] // Restore state
               });
          }
      }
      
      groupedLogs = tempGroups;
  }

  $: filteredGroups = filter 
      ? groupedLogs.filter(g => 
          g.parent.action.type.toLowerCase().includes(filter.toLowerCase()) || 
          g.children.some(c => c.action.type.toLowerCase().includes(filter.toLowerCase()))
        )
      : groupedLogs;

  function select(entry: LogEntry) {
    selectedEntry = entry;
  }
  
  function toggleGroup(group: GroupedLog) {
      group.expanded = !group.expanded;
      expandedState[group.id] = group.expanded; // Save state
      groupedLogs = groupedLogs; // Reactivity trigger
  }
  
  function clear() {
      devtoolsStore.clear();
      expandedState = {};
      selectedEntry = null;
  }
</script>

<div class="devtools-container">
  <div class="sidebar">
    <div class="toolbar">
        <input type="text" placeholder="Filter actions..." bind:value={filter} />
        <button on:click={clear}>Clear</button>
    </div>
    <div class="log-list">
      {#each filteredGroups as group (group.id)}
        <div class="group-wrapper">
             <!-- Parent Action -->
             <!-- svelte-ignore a11y-click-events-have-key-events -->
             <div 
               class="log-item parent" 
               class:selected={selectedEntry === group.parent}
               on:click={() => select(group.parent)}
               role="button"
               tabindex="0"
               in:fade={{duration: 100}}
             >
               {#if group.children.length > 0}
                   <span 
                     class="twisty" 
                     class:expanded={group.expanded}
                     on:click|stopPropagation={() => toggleGroup(group)}
                   >▶</span>
               {:else}
                   <span class="twisty placeholder"></span>
               {/if}
               
               <div class="content">
                   <div class="meta">
                     <span class="id">#{group.parent.id}</span>
                     <span class="time">{new Date(group.parent.timestamp).toLocaleTimeString()}</span>
                   </div>
                   <div class="type" title={group.parent.action.type}>{group.parent.action.type}</div>
               </div>
             </div>
             
             <!-- Children -->
             {#if group.expanded}
                 {#each group.children as child (child.id)}
                     <!-- svelte-ignore a11y-click-events-have-key-events -->
                     <div 
                       class="log-item child" 
                       class:selected={selectedEntry === child}
                       on:click={() => select(child)}
                       role="button"
                       tabindex="0"
                       in:fade={{duration: 100}}
                     >
                        <div class="content">
                           <!-- No Date for children -->
                           <div class="meta">
                               <span class="id">#{child.id}</span>
                           </div>
                           <div class="type" title={child.action.type}>{child.action.type}</div>
                        </div>
                     </div>
                 {/each}
             {/if}
        </div>
      {/each}
      {#if filteredGroups.length === 0}
        <div class="empty">No actions recorded.</div>
      {/if}
    </div>
  </div>

  <div class="main-panel">
    {#if selectedEntry}
      <div class="panel-content">
        <div class="section">
           <h2>Action</h2>
           <div class="tree-wrapper">
             <JsonTree value={selectedEntry.action} label="action" expanded={true} />
           </div>
        </div>
        <div class="section">
           <h2>State (After)</h2>
           <div class="tree-wrapper">
             <JsonTree value={selectedEntry.state} label="state" expanded={true} />
           </div>
        </div>
      </div>
    {:else}
      <div class="placeholder">Select an action to inspect</div>
    {/if}
  </div>
</div>

<style>
  .devtools-container {
    display: flex;
    height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    background: #f5f5f5;
  }

  .sidebar {
    width: 350px;
    background: #fff;
    border-right: 1px solid #ddd;
    display: flex;
    flex-direction: column;
  }

  .toolbar {
      padding: 10px;
      border-bottom: 1px solid #eee;
      display: flex;
      gap: 10px;
  }
  
  .toolbar input {
      flex: 1;
      padding: 4px 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
  }
  
  .toolbar button {
      padding: 4px 12px;
      background: #eee;
      border: 1px solid #ccc;
      border-radius: 4px;
      cursor: pointer;
  }
  
  .toolbar button:hover {
      background: #e0e0e0;
  }

  .log-list {
    flex: 1;
    overflow-y: auto;
  }

  .group-wrapper {
      border-bottom: 1px solid #f0f0f0;
  }

  .log-item {
    display: flex;
    align-items: flex-start;
    padding: 8px 10px;
    cursor: pointer;
    transition: background 0.1s;
    border-bottom: none; /* Handled by wrapper or child */
  }
  
  .log-item.parent {
      background: #fff;
  }

  .log-item.child {
      padding-left: 30px; /* Indent children */
      background: #fafafa;
      border-top: 1px solid #f5f5f5;
  }

  .log-item:hover {
    background: #f9f9f9;
  }
  
  .log-item.child:hover {
      background: #f0f0f0;
  }

  .log-item.selected {
    background: #e6f7ff !important;
    border-left: 4px solid #1890ff;
  }
  
  /* Adjust padding when selected to compensate for border width */
  .log-item.selected {
      padding-left: 6px; 
  }
  .log-item.child.selected {
      padding-left: 26px;
  }

  .twisty {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      margin-right: 5px;
      font-size: 10px;
      color: #666;
      transition: transform 0.1s;
      flex-shrink: 0;
      border-radius: 4px;
      position: relative;
      z-index: 10; /* Ensure it stays above row clicks */
  }
  
  .twisty:hover {
      background-color: #eee;
      color: #333;
  }
  
  .twisty.expanded {
      transform: rotate(90deg);
  }
  
  .twisty.placeholder {
      visibility: hidden; /* Keep spacing alignment */
  }
  
  .content {
      flex: 1;
      overflow: hidden;
  }

  .meta {
    display: flex;
    justify-content: space-between;
    font-size: 11px;
    color: #999;
    margin-bottom: 2px;
  }

  .type {
    font-weight: 500;
    font-size: 13px;
    color: #333;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .main-panel {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .panel-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
  }
  
  .section {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid #ddd;
  }
  
  .section h2 {
      margin: 0;
      padding: 8px 15px;
      background: #eaeaea;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #666;
      border-bottom: 1px solid #ddd;
  }
  
  .tree-wrapper {
      flex: 1;
      overflow: auto;
      padding: 15px;
      background: #fff;
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #999;
  }
  
  .empty {
      padding: 20px;
      text-align: center;
      color: #999;
      font-style: italic;
  }
</style>
