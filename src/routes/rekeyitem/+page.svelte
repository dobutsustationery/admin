<script lang="ts">
  import { store } from "$lib/store";
  import { rootReducer } from "$lib/root-reducer";
  import { fix_jancode } from "$lib/inventory";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { user } from "$lib/user-store";
  import { canonicalizeInventoryItemKey, makeInventoryItemKey } from "$lib/sku";
  import { diff, type Patch } from "@ourway/patch";

  let itemKey = "";
  let newJanCode = "";
  let subtype = "";
  let mergeMode: "strict" | "merge_if_identical" = "merge_if_identical";
  let reason = "";

  let preview: any = null;
  let previewError = "";
  let working = false;
  let lastBroadcastId = "";
  let confirmChecked = false;
  let confirmText = "";
  let showRawPatch = false;

  function nowTimestamp() {
    const ms = Date.now();
    return {
      ms,
      timestamp: {
        seconds: Math.floor(ms / 1000),
        nanoseconds: (ms % 1000) * 1_000_000,
      },
    };
  }

  type FlatChange = {
    path: string;
    before: any;
    after: any;
  };

  type SectionPreview = {
    label: string;
    changeCount: number;
    changes: FlatChange[];
  };

  function shortValue(value: unknown): string {
    if (value === undefined) return "undefined";
    const text = JSON.stringify(value);
    if (!text) return String(value);
    if (text.length > 140) return `${text.slice(0, 140)}...`;
    return text;
  }

  function flattenPatch(
    patchValue: Patch | null,
    beforeValue: any,
    afterValue: any,
    basePath = "",
    out: FlatChange[] = [],
  ): FlatChange[] {
    if (patchValue === null) return out;
    if (
      typeof patchValue !== "object" ||
      patchValue === undefined ||
      patchValue === null
    ) {
      out.push({
        path: basePath || "(root)",
        before: beforeValue,
        after: afterValue,
      });
      return out;
    }

    Object.entries(patchValue as Record<string, unknown>).forEach(([k, v]) => {
      const nextPath = basePath ? `${basePath}.${k}` : k;
      const beforeChild =
        beforeValue && typeof beforeValue === "object"
          ? beforeValue[k]
          : undefined;
      const afterChild =
        afterValue && typeof afterValue === "object"
          ? afterValue[k]
          : undefined;

      if (
        v !== null &&
        typeof v === "object" &&
        beforeChild !== undefined &&
        afterChild !== undefined &&
        typeof beforeChild === "object" &&
        typeof afterChild === "object"
      ) {
        flattenPatch(v as Patch, beforeChild, afterChild, nextPath, out);
      } else {
        out.push({ path: nextPath, before: beforeChild, after: afterChild });
      }
    });

    return out;
  }

  function buildSectionDiff(
    label: string,
    beforeValue: any,
    afterValue: any,
    maxRows = 12,
  ): SectionPreview | null {
    const patchValue = diff(beforeValue, afterValue);
    if (patchValue === null) return null;
    const flattened = flattenPatch(patchValue, beforeValue, afterValue);
    return {
      label,
      changeCount: flattened.length,
      changes: flattened.slice(0, maxRows),
    };
  }

  function runPreview() {
    previewError = "";
    preview = null;
    confirmChecked = false;
    confirmText = "";

    const currentState = store.getState();
    const sourceKey = canonicalizeInventoryItemKey(itemKey);
    const sourceItem = currentState.inventory.idToItem[sourceKey];
    if (!sourceItem) {
      previewError = `Source item not found: ${sourceKey}`;
      return;
    }
    const normalizedJan = String(newJanCode || "")
      .trim()
      .replace(/\s+/g, "");
    if (!normalizedJan) {
      previewError = "New JAN code is required.";
      return;
    }

    const resolvedSubtype = (subtype || sourceItem.subtype || "").trim();
    const targetKey = makeInventoryItemKey(normalizedJan, resolvedSubtype);
    const targetExistsBefore = !!currentState.inventory.idToItem[targetKey];

    const payload: any = {
      itemKey: sourceKey,
      newJanCode: normalizedJan,
      mergeMode,
    };
    if (subtype.trim()) payload.subtype = subtype.trim();
    if (reason.trim()) payload.reason = reason.trim();

    const { ms, timestamp } = nowTimestamp();
    const simulatedAction = {
      ...fix_jancode(payload),
      id: `preview-fix-jancode-${ms}`,
      timestamp,
      _timestamp: ms,
    };

    const nextState = rootReducer(currentState, simulatedAction, () => {});

    const sections = [
      buildSectionDiff(
        "inventory.idToItem",
        currentState.inventory.idToItem,
        nextState.inventory.idToItem,
      ),
      buildSectionDiff(
        "inventory.idToHistory",
        currentState.inventory.idToHistory,
        nextState.inventory.idToHistory,
      ),
      buildSectionDiff(
        "inventory.orderIdToOrder",
        currentState.inventory.orderIdToOrder,
        nextState.inventory.orderIdToOrder,
      ),
      buildSectionDiff(
        "inventory.hiddenExceptions",
        currentState.inventory.hiddenExceptions || {},
        nextState.inventory.hiddenExceptions || {},
      ),
      buildSectionDiff(
        "listings.idToHandle",
        currentState.listings.idToHandle,
        nextState.listings.idToHandle,
      ),
      buildSectionDiff(
        "photos.janCodeToPhotos",
        currentState.photos.janCodeToPhotos,
        nextState.photos.janCodeToPhotos,
      ),
      buildSectionDiff(
        "listingCreation.proposals",
        currentState.listingCreation.proposals,
        nextState.listingCreation.proposals,
      ),
      buildSectionDiff(
        "listingCreation.activeBatchJans",
        currentState.listingCreation.activeBatchJans,
        nextState.listingCreation.activeBatchJans,
      ),
      buildSectionDiff(
        "listingCreation.originalBatchJans",
        currentState.listingCreation.originalBatchJans,
        nextState.listingCreation.originalBatchJans,
      ),
      buildSectionDiff(
        "orderImport.resolutions",
        currentState.orderImport.resolutions,
        nextState.orderImport.resolutions,
      ),
      buildSectionDiff(
        "shopifyImport.resolutions",
        currentState.shopifyImport.resolutions,
        nextState.shopifyImport.resolutions,
      ),
      buildSectionDiff(
        "keyAudit.ghostMap",
        currentState.keyAudit.ghostMap,
        nextState.keyAudit.ghostMap,
      ),
    ].filter(Boolean) as SectionPreview[];

    const totalChangeCount = sections.reduce(
      (sum, s) => sum + s.changeCount,
      0,
    );

    const rawPatch = {
      inventoryIdToItem: diff(
        currentState.inventory.idToItem,
        nextState.inventory.idToItem,
      ),
      inventoryIdToHistory: diff(
        currentState.inventory.idToHistory,
        nextState.inventory.idToHistory,
      ),
      inventoryOrderIdToOrder: diff(
        currentState.inventory.orderIdToOrder,
        nextState.inventory.orderIdToOrder,
      ),
      inventoryHiddenExceptions: diff(
        currentState.inventory.hiddenExceptions || {},
        nextState.inventory.hiddenExceptions || {},
      ),
      listingsIdToHandle: diff(
        currentState.listings.idToHandle,
        nextState.listings.idToHandle,
      ),
      photosJanCodeToPhotos: diff(
        currentState.photos.janCodeToPhotos,
        nextState.photos.janCodeToPhotos,
      ),
      listingCreationProposals: diff(
        currentState.listingCreation.proposals,
        nextState.listingCreation.proposals,
      ),
      listingCreationActiveBatchJans: diff(
        currentState.listingCreation.activeBatchJans,
        nextState.listingCreation.activeBatchJans,
      ),
      listingCreationOriginalBatchJans: diff(
        currentState.listingCreation.originalBatchJans,
        nextState.listingCreation.originalBatchJans,
      ),
      orderImportResolutions: diff(
        currentState.orderImport.resolutions,
        nextState.orderImport.resolutions,
      ),
      shopifyImportResolutions: diff(
        currentState.shopifyImport.resolutions,
        nextState.shopifyImport.resolutions,
      ),
      keyAuditGhostMap: diff(
        currentState.keyAudit.ghostMap,
        nextState.keyAudit.ghostMap,
      ),
    };

    preview = {
      action: simulatedAction,
      keyRemap: {
        sourceKey,
        targetKey,
        targetExistsBefore,
      },
      sourceItemBefore: currentState.inventory.idToItem[sourceKey] || null,
      targetItemAfter: nextState.inventory.idToItem[targetKey] || null,
      totalChangeCount,
      sections,
      rawPatch,
    };
  }

  async function confirmBroadcast() {
    if (!preview) return;
    if (!$user?.uid) {
      previewError = "You must be signed in to broadcast this action.";
      return;
    }
    if (!confirmChecked || confirmText !== "REKEY") {
      previewError = "Confirmation gate is not satisfied.";
      return;
    }

    working = true;
    previewError = "";
    try {
      const payload = preview.action.payload;
      const sent = await broadcast(firestore, $user.uid, fix_jancode(payload));
      lastBroadcastId = sent?.id || "(broadcast sent)";
    } catch (error: any) {
      previewError = error?.message || String(error);
    } finally {
      working = false;
    }
  }
</script>

<main class="wrap">
  <h1>Rekey Inventory Item (Hidden Admin Tool)</h1>
  <p class="warning">
    This route is intentionally not linked from the UI. Use with caution.
  </p>

  <section class="panel">
    <label>
      Current Item Key
      <input bind:value={itemKey} placeholder="e.g. 4901234567890Blue" />
    </label>

    <label>
      New JAN Code
      <input bind:value={newJanCode} placeholder="e.g. 4901234567899" />
    </label>

    <label>
      Subtype Override (optional)
      <input
        bind:value={subtype}
        placeholder="leave blank to keep current subtype"
      />
    </label>

    <label>
      Merge Mode
      <select bind:value={mergeMode}>
        <option value="merge_if_identical">merge_if_identical</option>
        <option value="strict">strict</option>
      </select>
    </label>

    <label>
      Reason (optional)
      <input bind:value={reason} placeholder="why this correction is needed" />
    </label>

    <button class="btn" on:click={runPreview} disabled={working}>
      Preview State Changes
    </button>
  </section>

  {#if previewError}
    <div class="error">{previewError}</div>
  {/if}

  {#if preview}
    <section class="panel">
      <h2>Preview</h2>
      <div class="preview-meta">
        <div>
          <strong>From:</strong> <code>{preview.keyRemap.sourceKey}</code>
        </div>
        <div>
          <strong>To:</strong> <code>{preview.keyRemap.targetKey}</code>
        </div>
        <div>
          <strong>Total Changed Paths:</strong>
          {preview.totalChangeCount}
        </div>
      </div>

      <div class="snippet-grid">
        <div>
          <h3>Source Item (Before)</h3>
          <pre>{JSON.stringify(preview.sourceItemBefore, null, 2)}</pre>
        </div>
        <div>
          <h3>Target Item (After)</h3>
          <pre>{JSON.stringify(preview.targetItemAfter, null, 2)}</pre>
        </div>
      </div>

      {#each preview.sections as section}
        <div class="section">
          <h3>{section.label} ({section.changeCount})</h3>
          <table class="diff-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {#each section.changes as change}
                <tr>
                  <td><code>{change.path}</code></td>
                  <td><code>{shortValue(change.before)}</code></td>
                  <td><code>{shortValue(change.after)}</code></td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if section.changeCount > section.changes.length}
            <div class="truncated-note">
              Showing {section.changes.length} of {section.changeCount} changes.
            </div>
          {/if}
        </div>
      {/each}

      <label class="inline toggle-raw">
        <input type="checkbox" bind:checked={showRawPatch} />
        Show raw patch JSON
      </label>
      {#if showRawPatch}
        <pre>{JSON.stringify(preview.rawPatch, null, 2)}</pre>
      {/if}
    </section>

    <section class="danger">
      <h2>Danger Zone</h2>
      <p>
        Are you sure you want to broadcast this JAN re-key action? This is
        append-only event history and affects replay.
      </p>
      <label class="inline">
        <input type="checkbox" bind:checked={confirmChecked} />
        I understand this is a destructive correction.
      </label>
      <label>
        Type <code>REKEY</code> to confirm
        <input bind:value={confirmText} placeholder="REKEY" />
      </label>
      <button
        class="btn-danger"
        on:click={confirmBroadcast}
        disabled={!confirmChecked || confirmText !== "REKEY" || working}
      >
        Confirm and Broadcast fix_jancode
      </button>
      {#if lastBroadcastId}
        <p class="success">Broadcast sent: {lastBroadcastId}</p>
      {/if}
    </section>
  {/if}
</main>

<style>
  .wrap {
    max-width: 920px;
    margin: 1.5rem auto;
    padding: 0 1rem 2rem;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
  }

  .warning {
    color: #92400e;
    background: #fffbeb;
    border: 1px solid #fcd34d;
    padding: 0.75rem;
    border-radius: 0.5rem;
  }

  .panel {
    margin-top: 1rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
  }

  .panel pre {
    margin: 0;
    overflow: auto;
    max-height: 28rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .preview-meta {
    display: grid;
    gap: 0.35rem;
  }

  .snippet-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    align-items: start;
  }

  .section {
    margin-top: 0.5rem;
  }

  .diff-table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .diff-table th,
  .diff-table td {
    border: 1px solid #e5e7eb;
    padding: 0.4rem;
    vertical-align: top;
    text-align: left;
    word-break: break-word;
  }

  .truncated-note {
    color: #6b7280;
    font-size: 0.85rem;
    margin-top: 0.25rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: 0.9rem;
  }

  .inline {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  input,
  select {
    border: 1px solid #d1d5db;
    border-radius: 0.4rem;
    padding: 0.5rem 0.6rem;
    font: inherit;
  }

  .btn {
    width: fit-content;
    padding: 0.6rem 0.9rem;
    border-radius: 0.4rem;
    border: 1px solid #111827;
    background: #111827;
    color: #fff;
    cursor: pointer;
  }

  .danger {
    margin-top: 1rem;
    border: 1px solid #b91c1c;
    border-radius: 0.5rem;
    background: #fef2f2;
    padding: 1rem;
    display: grid;
    gap: 0.75rem;
  }

  .btn-danger {
    width: fit-content;
    padding: 0.6rem 0.9rem;
    border-radius: 0.4rem;
    border: 1px solid #991b1b;
    background: #b91c1c;
    color: #fff;
    cursor: pointer;
  }

  .btn-danger:disabled,
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error {
    margin-top: 1rem;
    color: #991b1b;
    background: #fef2f2;
    border: 1px solid #fecaca;
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .success {
    color: #065f46;
    background: #ecfdf5;
    border: 1px solid #a7f3d0;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    margin: 0;
  }
</style>
