<script lang="ts">
  import { store } from "$lib/store";
  import Celebration from "$lib/components/Celebration.svelte";
  // HMR Trigger
  import { onMount } from "svelte";
  import { browser } from "$app/environment";
  import {
    generate_proposals,
    start_batch,
    generate_descriptions_for_batch,
    regenerate_description,
    set_current_step,
    recalculate_batch_navigation,
    set_proposal_handle_thunk,
    mark_celebrated,
    set_global_prompts,
  } from "$lib/listing-creation-slice";
  import ProgressBar from "$lib/components/ProgressBar.svelte";
  import { goto } from "$app/navigation";

  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-drive";
  import {
    set_drive_connection_status,
    update_proposal_field,
    update_variant_value,
    update_variant_image,
  } from "$lib/listing-creation-slice";
  import BulkEditor, {
    type ColumnConfig,
  } from "$lib/components/BulkEditor.svelte";
  import { generateHandle } from "$lib/handle-utils";
  import ViewCell from "$lib/components/cell-renderers/ViewCell.svelte";
  import BodyHtmlCell from "$lib/components/cell-renderers/BodyHtmlCell.svelte";
  import ImageCell from "$lib/components/cell-renderers/ImageCell.svelte";
  import BodyHtmlModal from "$lib/components/BodyHtmlModal.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { update_field } from "$lib/inventory";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import { set_column_width } from "$lib/ui-slice";

  // Subscribe to state
  $: listingCreation = $store.listingCreation;
  $: photosState = $store.photos;
  $: proposals = Object.values(listingCreation.proposals) as any[];
  $: activeBatchJans = listingCreation.activeBatchJans;
  $: originalBatchJans = listingCreation.originalBatchJans;
  $: visibleBatchJans =
    originalBatchJans && originalBatchJans.length > 0
      ? originalBatchJans
      : activeBatchJans;

  // Sort State (Bulk Editor)
  type SortDir = "asc" | "desc";
  interface SortRule {
    field: string;
    dir: SortDir;
  }
  const sortStorageKey = "bulk-editor-sort-batch";
  let sortHistory: SortRule[] = [];

  $: driveStatus = listingCreation.driveConnectionStatus;
  $: isScanning = listingCreation.isScanning;
  $: scanProgress = listingCreation.scanProgress;

  let showImagePicker = false;
  let imagePickerRow: any | null = null;

  let showBodyModal = false;
  let bodyModalJan: string | null = null;
  let bodyModalValue = "";

  let showDescPromptModal = false;
  let descPromptValue = "";

  let showVariantPromptModal = false;
  let variantPromptValue = "";

  let showCelebration = false;
  let showReturnToShopifyProducts = false;

  $: completedBatchId = listingCreation.lastCompletedBatchId;
  $: if (
    typeof completedBatchId === "string" &&
    !listingCreation.hasCelebrated
  ) {
    console.log("[Celebration] Triggering! Batch:", completedBatchId);
    // Persist celebration ack via broadcast so replay state knows this batch was celebrated.
    dispatchBroadcast(mark_celebrated());
    showCelebration = true;
    showReturnToShopifyProducts = false;
    setTimeout(() => {
      showReturnToShopifyProducts = true;
    }, 3500); // Allow animation to play out
  } else if (completedBatchId === undefined) {
    showCelebration = false;
    showReturnToShopifyProducts = false;
  }

  function handleGoToShopifyProducts() {
    goto("/shopify-products");
  }

  // Derived
  $: hasOrganizedPhotos =
    photosState &&
    photosState.janCodeToPhotos &&
    Object.keys(photosState.janCodeToPhotos).length > 0;
  $: draftCount = proposals.filter((p) => p.status === "draft").length;

  // Use state directly to avoid ReferenceError on intermediate variables
  $: activeProposal =
    activeBatchJans.length > 0 && listingCreation.currentStepIndex >= 0
      ? listingCreation.proposals[
          activeBatchJans[listingCreation.currentStepIndex]
        ]
      : null;

  $: isBulkEditMode =
    activeBatchJans.length > 0 && listingCreation.currentStepIndex === -1;

  // Enrich proposals with Image Data for Grid AND Variant Fields for Columns
  // FLATTENED: Create one row per VARIANT, not per Proposal.
  $: flattenedRows = proposals.flatMap((p) => {
    // If no variants defined (shouldn't happen for valid proposals), fallback to dummy
    const variants =
      p.variants && p.variants.length > 0
        ? p.variants
        : [{ itemId: p.janCode, option1Value: "" }];

    return variants.map((v: any, idx: number) => {
      // Resolve Items:
      // 1. Specific Variant Item (if exists in inventory, e.g. re-editing or existing item)
      // 2. Source Item (if variant is new/split, use parent proposal's locked item)
      let inventoryItem = $store.inventory.idToItem[v.itemId];

      // Fallback to source item if specific item not found (this happens for new split variants)
      const sourceItem =
        p.inventoryItemIds && p.inventoryItemIds.length > 0
          ? $store.inventory.idToItem[p.inventoryItemIds[0]]
          : null;

      if (!inventoryItem) {
        inventoryItem = sourceItem;
      }

      // Photo Lookup Strategy:
      // 1. Explicit Photo Group Key (from Subtype Automation)
      // 2. Specific Variant JAN (SKU)
      // 3. Linked Photo Groups (from split/merge)
      // 4. Proposal Key (Fallback)
      let photos: any[] = [];

      if (v.photoGroupKey && photosState?.janCodeToPhotos?.[v.photoGroupKey]) {
        photos = photosState.janCodeToPhotos[v.photoGroupKey];
      } else if (v.itemId && photosState?.janCodeToPhotos?.[v.itemId]) {
        // Check if photos exist for the Variant SKU (e.g. "123Red")
        photos = photosState.janCodeToPhotos[v.itemId];
      } else if (
        inventoryItem?.janCode &&
        photosState?.janCodeToPhotos?.[inventoryItem.janCode]
      ) {
        photos = photosState.janCodeToPhotos[inventoryItem.janCode];
      } else if (p.photoGroupIds && p.photoGroupIds.length > 0) {
        // Aggregate all groups? Or just take first valid?
        // For thumbnail, first valid is fine.
        for (const groupId of p.photoGroupIds) {
          const group = photosState?.janCodeToPhotos?.[groupId];
          if (group && group.length > 0) {
            photos = group;
            break;
          }
        }
      } else if (photosState?.janCodeToPhotos?.[p.janCode]) {
        photos = photosState.janCodeToPhotos[p.janCode];
      }

      const thumb =
        photos && photos.length > 0
          ? photos[0].baseUrl || photos[0].thumbnailLink
          : null;

      // Prioritize draft variant image override, then inventory image
      const variantThumb = v.image || inventoryItem?.image || null;

      // Construct Display SKU
      const variantSku = p.janCode + (v.option1Value || "").replace(/\s+/g, "");

      return {
        ...p, // Spread Shared Listing Props (Title, Handle, Price, Body, etc.)

        // Computed Fields
        computedHandle: p.handle || generateHandle(p.title || "", p.janCode),
        _viewMode: "create",

        // Row Identity
        rowId: v.id || v.itemId, // Unique ID for the grid row (variant instance ID preferred)
        id: v.itemId, // For Image Picker compatibility (Inventory ID)
        sku: variantSku, // For Display
        janCode: p.janCode, // Reference to parent Proposal

        // Variant Specifics
        variantId: v.id,
        option1Value: v.option1Value,
        allocatedQty: (() => {
          if (v.qty !== undefined) return v.qty;
          // Prefer per-variant inventory qty when available.
          if (inventoryItem && typeof inventoryItem.qty === "number") {
            return inventoryItem.qty;
          }
          // Fallback: compute split allocation from parent source qty.
          const total = sourceItem ? sourceItem.qty : 0;
          const count =
            p.variants && p.variants.length > 0 ? p.variants.length : 1;
          const base = Math.floor(total / count);
          const remainder = total % count;
          // We need a stable index. idx is stable for this map.
          const extra = idx < remainder ? 1 : 0;
          return base + extra;
        })(),
        sourceQty: sourceItem ? sourceItem.qty : 0, // Total available from SOURCE
        photoGroupKey: v.photoGroupKey,

        // Images: Variant image > Variant JAN Group Image
        _thumbnail: variantThumb || thumb,

        // We use these for display/logic but they are derived
        _variantIndex: idx,
        _isPrimary: idx === 0,
      };
    });
  });

  function handleSort(e: CustomEvent<{ field: string }>) {
    const field = e.detail.field;
    const existingIndex = sortHistory.findIndex((r) => r.field === field);
    const current = existingIndex === -1 ? null : sortHistory[existingIndex];

    if (!current) {
      sortHistory = [{ field, dir: "asc" }, ...sortHistory];
      return;
    }

    if (existingIndex === 0) {
      if (current.dir === "asc") {
        sortHistory = [{ field, dir: "desc" }, ...sortHistory.slice(1)];
      } else {
        sortHistory = sortHistory.slice(1);
      }
      return;
    }

    const cleanHistory = sortHistory.filter((r) => r.field !== field);
    sortHistory = [{ field, dir: current.dir }, ...cleanHistory];
  }

  function getSortValue(row: any, field: string) {
    if (field === "handle") return row.handle || row.computedHandle || "";
    if (field === "title") return row.title || "";
    if (field === "bodyHtml") return row.bodyHtml || "";
    if (field === "productCategory") return row.productCategory || "";
    if (field === "option1Name") return row.option1Name || "";
    if (field === "option1Value") return row.option1Value || "";
    if (field === "photoGroupKey") return row.photoGroupKey || "";
    if (field === "allocatedQty") return row.allocatedQty ?? 0;
    if (field === "price") return row.price ?? 0;
    if (field === "sku") return row.sku || "";
    if (field === "janCode") return row.janCode || "";
    return row[field];
  }

  $: bulkRows = flattenedRows.filter((p) =>
    visibleBatchJans.includes(p.janCode),
  );

  $: sortedBulkRows = bulkRows
    .map((row, index) => ({ ...row, _sortIndex: index }))
    .sort((a, b) => {
      if (sortHistory.length === 0) {
        return a._sortIndex - b._sortIndex;
      }
      for (const rule of sortHistory) {
        const valA = getSortValue(a, rule.field);
        const valB = getSortValue(b, rule.field);
        const aVal = valA ?? "";
        const bVal = valB ?? "";
        if (typeof aVal === "number" && typeof bVal === "number") {
          if (aVal < bVal) return rule.dir === "asc" ? -1 : 1;
          if (aVal > bVal) return rule.dir === "asc" ? 1 : -1;
        } else {
          const cmp = String(aVal).localeCompare(String(bVal));
          if (cmp !== 0) return rule.dir === "asc" ? cmp : -cmp;
        }
      }
      return a._sortIndex - b._sortIndex;
    });

  // Redirect if Active Proposal Found (and not in Bulk Mode)
  // Ensure we don't trigger this mid-state transition if index is invalid
  $: if (
    activeProposal &&
    !isBulkEditMode &&
    typeof listingCreation.currentStepIndex === "number" &&
    listingCreation.currentStepIndex >= 0
  ) {
    goto(`/listing-detail?mode=create&jan=${activeProposal.janCode}`);
  }

  function handleStartReview() {
    store.dispatch(set_current_step(0));
  }

  onMount(() => {
    // Check initial auth state
    if (isAuthenticated()) {
      if (driveStatus !== "connected") {
        store.dispatch(set_drive_connection_status("connected"));
      }
    } else {
      if (driveStatus !== "disconnected") {
        store.dispatch(set_drive_connection_status("disconnected"));
      }
    }

    // IMPORTANT: If we land on this page and we are in a batch, we assume the user wants to see the Batch Editor (Step -1).
    // This prevents the infinite redirect loop if the user clicks "Back" from a listing detail page (Step 0, 1, etc.)
    // If they want to "Resume", they can click "Start Review" again.
    if (activeBatchJans.length > 0 && listingCreation.currentStepIndex !== -1) {
      store.dispatch(set_current_step(-1));
    }

    if (browser) {
      const raw = localStorage.getItem(sortStorageKey);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            sortHistory = parsed.filter(
              (r) => r && r.field && (r.dir === "asc" || r.dir === "desc"),
            );
          }
        } catch {
          localStorage.removeItem(sortStorageKey);
        }
      }
    }
  });

  $: if (browser) {
    localStorage.setItem(sortStorageKey, JSON.stringify(sortHistory));
  }

  function dispatchBroadcast(action: any) {
    if (typeof action === "function") {
      return action(dispatchBroadcast, store.getState);
    }

    if ($user && $user.uid) {
      broadcast(firestore, $user.uid, action);
    } else {
      console.warn("User not authenticated, falling back to local dispatch");
      store.dispatch(action);
    }
  }

  function handleGenerate() {
    generate_proposals()(dispatchBroadcast, store.getState, undefined);
  }

  function handleStartBatch() {
    // Pick top 10 drafts (Reverted to 10 per design)
    const drafts = proposals.filter((p) => p.status === "draft").slice(0, 10);

    if (drafts.length === 0) {
      return;
    }

    const ids = drafts.map((p) => p.janCode);
    const batchId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `batch-${Date.now()}`;
    dispatchBroadcast(
      start_batch({ janCodes: ids, batchId, createdAt: Date.now() }),
    );
    generate_descriptions_for_batch(ids)(
      dispatchBroadcast,
      store.getState,
      undefined,
    );
    // Redirect handled by reactive statement above
  }

  function handleConnect() {
    initiateOAuthFlow(window.location.href);
  }

  // --- Progress ---
  $: totalInBatch = originalBatchJans ? originalBatchJans.length : 0;
  $: remainingInBatch = activeBatchJans.length;
  $: doneInBatch = totalInBatch - remainingInBatch;
  $: progressPercent =
    totalInBatch > 0 ? (doneInBatch / totalInBatch) * 100 : 0;

  // --- Bulk Editor Config ---
  const baseColumnConfig: ColumnConfig[] = [
    {
      field: "view",
      header: "View",
      width: 50,
      editable: false,
      type: "component",
      component: ViewCell,
    },
    {
      field: "_thumbnail",
      header: "Image",
      width: 60,
      type: "component",
      component: ImageCell,
      editable: false,
    },

    {
      field: "handle",
      header: "Handle",
      width: 200,
      type: "text",
      placeholderField: "computedHandle",
    },
    { field: "title", header: "Title", width: 300, type: "text" },
    {
      field: "bodyHtml",
      header: "Body (HTML)",
      width: 300,
      type: "component",
      component: BodyHtmlCell,
      editable: false,
    },
    {
      field: "productCategory",
      header: "Product Category",
      width: 150,
      type: "text",
    },
    { field: "option1Name", header: "Option1 Name", width: 120, type: "text" },
    {
      field: "option1Value",
      header: "Option1 Value",
      width: 120,
      type: "text",
    },
    {
      field: "photoGroupKey",
      header: "Photo Group",
      width: 120,
      editable: false,
    },
    {
      field: "allocatedQty",
      header: "Stock",
      width: 80,
      type: "number",
      align: "right",
    },

    {
      field: "price",
      header: "Price",
      width: 100,
      type: "number",
      align: "right",
    },
    { field: "sku", header: "Variant SKU", width: 150, editable: false },
    { field: "janCode", header: "Barcode", width: 120, editable: false },
  ];

  $: columnConfig = baseColumnConfig.map((c) => {
    const w = $store.ui?.columnWidths?.[`batch_${c.field}`];
    return w ? { ...c, width: w } : c;
  });

  function handleResize(e: CustomEvent<{ field: string; width: number }>) {
    dispatchBroadcast(
      set_column_width({
        view: "batch",
        field: e.detail.field,
        width: e.detail.width,
      }),
    );
  }

  function handleCommit(
    rowId: string,
    field: string,
    value: any,
    index: number,
  ) {
    // Find the row data to get the real context
    const row = flattenedRows.find((r) => r.rowId === rowId);
    if (!row) {
      console.error("Could not find row for commit", rowId);
      return;
    }

    const janCode = row.janCode;
    if (field === "handle") {
      const newHandle = value;
      // In batch view, Handle is a proposal-level field. Passing variantId here can
      // trigger split behavior and create hidden duplicate-handle proposals.
      dispatchBroadcast(
        set_proposal_handle_thunk(janCode, undefined, newHandle),
      );
    } else if (field === "option1Value") {
      if (row.variantId) {
        dispatchBroadcast(
          update_variant_value({ janCode, variantId: row.variantId, value }),
        );
      }
    } else {
      // Standard Update
      // Since we now have "One Proposal = One Listing", we don't need to sync across multiple proposals.
      // However, if we edit a shared field (Title), it applies to the Proposal (and thus all its variants).
      dispatchBroadcast(
        update_proposal_field({ janCode, field: field as any, value }),
      );
    }
  }

  function handleBulkCommit(
    e: CustomEvent<{ id: string; field: string; value: any; index: number }>,
  ) {
    handleCommit(e.detail.id, e.detail.field, e.detail.value, e.detail.index);
  }

  function handleBulkImagePick(e: CustomEvent<{ item: any }>) {
    openImagePicker(e.detail.item);
  }

  function handleBulkEditHtml(e: CustomEvent<{ item: any }>) {
    openBodyModal(e.detail.item);
  }

  function openImagePicker(row: any) {
    imagePickerRow = row;
    showImagePicker = true;
  }

  function buildImagePickerCandidates(row: any) {
    if (!row) return [];
    const janCode = row.janCode;
    const targetProposal = proposals.find((p) => p.janCode === janCode);
    if (!targetProposal) return [];
    const handleKey =
      targetProposal.handle ||
      generateHandle(targetProposal.title || "", targetProposal.janCode);
    const siblings = proposals.filter((p) => {
      const h = p.handle || generateHandle(p.title || "", p.janCode);
      return h === handleKey;
    });

    const candidates = new Map<
      string,
      { id: string; url: string; altText: string }
    >();

    // 1. Photos from related groups (Base JAN prefix search)
    const allPhotoKeys = Object.keys(photosState?.janCodeToPhotos || {});
    const searchPrefix = targetProposal.janCode.toString().trim();
    const relatedKeys = allPhotoKeys.filter(
      (k) => k === searchPrefix || k.startsWith(searchPrefix + ":"),
    );

    relatedKeys.forEach((k) => {
      const photos = photosState.janCodeToPhotos[k] || [];
      photos.forEach((p: any, idx: number) => {
        const url = p.baseUrl || p.thumbnailLink || p.productUrl;
        if (!url) return;
        if (!candidates.has(url)) {
          candidates.set(url, {
            id: p.id || `group-${k}-${idx}`,
            url,
            altText: p.filename || `Photo Group ${k}`,
          });
        }
      });
    });

    // 2. Photos from explicitly linked Photo Groups (that might not match prefix)
    if (targetProposal.photoGroupIds) {
      targetProposal.photoGroupIds.forEach((gid: string) => {
        if (relatedKeys.includes(gid)) return; // Already added
        const groupPhotos = photosState?.janCodeToPhotos?.[gid] || [];
        groupPhotos.forEach((p: any, idx: number) => {
          const url = p.baseUrl || p.thumbnailLink || p.productUrl;
          if (!url) return;
          if (!candidates.has(url)) {
            candidates.set(url, {
              id: p.id || `group-${gid}-${idx}`,
              url,
              altText: p.filename || `Photo Group ${gid}`,
            });
          }
        });
      });
    }

    siblings.forEach((p) => {
      p.inventoryItemIds?.forEach((id: string) => {
        const item = $store.inventory.idToItem[id];
        if (!item?.image) return;
        const url = item.image;
        if (!candidates.has(url)) {
          candidates.set(url, {
            id: `variant-${id}`,
            url,
            altText: item.subtype || "Variant image",
          });
        }
      });
    });

    return Array.from(candidates.values());
  }

  function handlePickVariantImage(candidate: { id: string; url: string }) {
    if (!imagePickerRow) return;

    // Use Variant Context to update Draft State
    const janCode = imagePickerRow.janCode;
    const variantId = imagePickerRow.variantId;

    if (janCode && variantId) {
      dispatchBroadcast(
        update_variant_image({ janCode, variantId, image: candidate.url }),
      );
    } else {
      // Fallback to Inventory Update (e.g. legacy)
      const itemId = imagePickerRow.id;
      const item = $store.inventory.idToItem[itemId];
      const from = item?.image || "";
      dispatchBroadcast(
        update_field({ id: itemId, field: "image", from, to: candidate.url }),
      );
    }

    showImagePicker = false;
    imagePickerRow = null;
  }

  function openBodyModal(row: any) {
    bodyModalJan = row?.janCode || null;
    bodyModalValue = row?.bodyHtml || "";
    showBodyModal = true;
  }

  function saveBodyModal(e: CustomEvent<{ value: string }>) {
    if (!bodyModalJan) return;
    dispatchBroadcast(
      update_proposal_field({
        janCode: bodyModalJan,
        field: "bodyHtml",
        value: e.detail.value,
      }),
    );
    showBodyModal = false;
    bodyModalJan = null;
  }

  function cancelBodyModal() {
    showBodyModal = false;
    bodyModalJan = null;
  }

  function handleRegenerateDescription() {
    if (!bodyModalJan) return;
    regenerate_description(bodyModalJan)(
      dispatchBroadcast,
      store.getState,
      undefined,
    );
  }

  function openDescriptionPrompt() {
    const prompt =
      listingCreation.globalDescriptionPrompt ||
      "Write a playful product description in HTML.";
    descPromptValue = prompt;
    showDescPromptModal = true;
  }

  function runDescriptionPrompt() {
    if (!bodyModalJan) return;
    regenerate_description(bodyModalJan, descPromptValue)(
      dispatchBroadcast,
      store.getState,
      undefined,
    );
    showDescPromptModal = false;
  }

  function openVariantPrompt() {
    const prompt = listingCreation.globalVariantPrompt || "";
    variantPromptValue = prompt;
    showVariantPromptModal = true;
  }

  function saveVariantPrompt() {
    dispatchBroadcast(
      set_global_prompts({ variantPrompt: variantPromptValue }),
    );
    showVariantPromptModal = false;
  }

  $: if (showBodyModal && bodyModalJan) {
    const next = $store.listingCreation.proposals[bodyModalJan]?.bodyHtml || "";
    if (next !== bodyModalValue) {
      bodyModalValue = next;
    }
  }
</script>

<div class="page-container">
  <h1 class="page-title">Create Listings</h1>

  {#if showCelebration}
    <Celebration />
    {#if showReturnToShopifyProducts}
      <div class="celebration-action-overlay">
        <div class="celebration-action-container">
          <button
            on:click={handleGoToShopifyProducts}
            class="btn-return-dashboard"
          >
            Go to Shopify Products
          </button>
        </div>
      </div>
    {/if}
  {/if}

  {#if driveStatus === "disconnected"}
    <div class="connection-required-panel">
      <h2 class="panel-title">Google Drive Connection Required</h2>
      <p class="panel-message">
        Please connect Google Drive to scan for product photos.
      </p>
      <button on:click={handleConnect} class="btn-connect">
        Connect Google Drive
      </button>
    </div>
  {:else if isBulkEditMode}
    <div id="bulk-editor-container" class="editor-layout">
      <div class="editor-header">
        <div class="editor-progress-section">
          <div class="progress-info">
            <h2 class="editor-title">
              Batch Editor ({remainingInBatch} items remaining)
            </h2>
            <span class="progress-stats"
              >{doneInBatch} / {totalInBatch} Completed</span
            >
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: {progressPercent}%"></div>
          </div>
        </div>
        <button
          class="btn-save start-review-btn"
          on:click={() => {
            dispatchBroadcast(recalculate_batch_navigation());
            dispatchBroadcast(set_current_step(0));
          }}
        >
          <span>Start Review</span>
          <span aria-hidden="true">&rarr;</span>
        </button>
      </div>
      <BulkEditor
        data={sortedBulkRows}
        columns={columnConfig}
        frozenColumns={2}
        keyField="rowId"
        bind:sortHistory
        on:commit={handleBulkCommit}
        on:sort={handleSort}
        on:imagePick={handleBulkImagePick}
        on:editHtml={handleBulkEditHtml}
        on:resize={handleResize}
      />
    </div>
  {:else if draftCount > 0}
    <div class="drafts-ready-panel">
      <h2 class="panel-title">{draftCount} Drafts Ready</h2>
      <p class="panel-message">
        Start a batch to review and publish the next 10 listings.
      </p>
      <button on:click={handleStartBatch} class="btn-start-batch">
        Start Batch
      </button>
    </div>
  {:else}
    <div class="empty-batch-panel">
      <h2 class="empty-panel-title">No proposals found</h2>

      {#if !hasOrganizedPhotos}
        <div class="photo-warning-box">
          <p class="warning-title">No organized photos found.</p>
          <p>
            Creating listings requires photos to be matched to JAN codes first.
          </p>
          <p class="warning-action">
            Please go to <a href="/photos" class="warning-link"
              >Photos &gt; Organize</a
            > to categorize your uploads.
          </p>
        </div>
        <br />
      {/if}

      <div class="scan-controls-container">
        {#if isScanning}
          {@const now = Date.now()}
          {@const lastUpdate = scanProgress?.lastUpdate || 0}
          {@const isStalled = lastUpdate === 0 || now - lastUpdate > 30000}
          <div class="scan-progress-wrapper">
            <ProgressBar
              current={scanProgress?.current || 0}
              total={scanProgress?.total || 0}
              message={scanProgress?.message || "Scanning..."}
              color={isStalled ? "orange" : "blue"}
            />
            {#if isStalled}
              <div class="stall-warning-box">
                <p class="stall-message">
                  {#if lastUpdate === 0}
                    The scan state was restored but it doesn't seem to be
                    running.
                  {:else}
                    The scan seems to have stalled (no updates for {Math.round(
                      (now - lastUpdate) / 1000,
                    )}s).
                  {/if}
                </p>
                <button on:click={handleGenerate} class="btn-resume-scan">
                  Resume / Force Restart
                </button>
              </div>
            {/if}
          </div>
        {:else}
          <div class="scan-actions">
            <button on:click={handleGenerate} class="btn-scan">
              Scan for matched items
            </button>
            <button
              on:click={openVariantPrompt}
              class="ai-btn icon-only"
              title="Edit Subtype Prompt">✎</button
            >
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if showImagePicker}
  <div class="modal-backdrop">
    <div class="modal image-picker-modal">
      <h3 class="modal-title">Select image for this variant</h3>
      <div class="image-picker-grid">
        {#each buildImagePickerCandidates(imagePickerRow) as candidate}
          <button
            class="image-picker-item"
            on:click={() => handlePickVariantImage(candidate)}
          >
            <ImageThumbnail src={candidate.url} alt={candidate.altText} />
          </button>
        {/each}
      </div>
      <div class="modal-actions">
        <button
          class="btn-cancel"
          on:click={() => {
            showImagePicker = false;
            imagePickerRow = null;
          }}>Cancel</button
        >
      </div>
    </div>
  </div>
{/if}

{#if showBodyModal}
  <BodyHtmlModal
    open={showBodyModal}
    value={bodyModalValue}
    title="Edit Description HTML"
    showRegenerate={true}
    showPrompt={true}
    on:save={saveBodyModal}
    on:cancel={cancelBodyModal}
    on:regenerate={handleRegenerateDescription}
    on:editPrompt={openDescriptionPrompt}
  />
{/if}

{#if showDescPromptModal}
  <div class="modal-backdrop prompt-backdrop">
    <div class="modal prompt-modal">
      <h3 class="modal-title">Edit Description Prompt</h3>
      <textarea class="body-textarea" bind:value={descPromptValue}></textarea>
      <div class="modal-actions">
        <button
          class="btn-cancel"
          on:click={() => {
            showDescPromptModal = false;
          }}>Cancel</button
        >
        <button class="btn-save" on:click={runDescriptionPrompt}
          >Generate</button
        >
      </div>
    </div>
  </div>
{/if}

{#if showVariantPromptModal}
  <div class="modal-backdrop prompt-backdrop">
    <div class="modal prompt-modal">
      <h3 class="modal-title">Edit Subtype Detection Prompt</h3>
      <div class="prompt-hint">
        This prompt is used by Gemini to detect variants in photos. It must
        return strict JSON in the specified format.
      </div>
      <textarea class="body-textarea" bind:value={variantPromptValue}
      ></textarea>
      <div class="modal-actions">
        <button
          class="btn-cancel"
          on:click={() => {
            showVariantPromptModal = false;
          }}>Cancel</button
        >
        <button class="btn-save" on:click={saveVariantPrompt}>Save</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page-container {
    margin: 0 auto;
    padding: 1.5rem;
  }
  .page-title {
    font-size: 1.875rem;
    font-weight: 700;
    margin-bottom: 1.5rem;
  }
  .celebration-action-overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    pointer-events: none;
  }
  .celebration-action-container {
    pointer-events: auto;
    margin-top: 16rem;
  }
  .btn-return-dashboard {
    background-color: white;
    color: #2563eb;
    padding: 1rem 2rem;
    border-radius: 9999px;
    font-weight: 700;
    font-size: 1.25rem;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    transition: transform 0.2s;
    border: 4px solid #dbeafe;
    cursor: pointer;
  }
  .btn-return-dashboard:hover {
    transform: scale(1.05);
  }

  .connection-required-panel,
  .drafts-ready-panel {
    background-color: #fffbeb;
    padding: 2rem;
    border-radius: 0.5rem;
    border: 1px solid #fef3c7;
    text-align: center;
  }
  .drafts-ready-panel {
    background-color: white;
    box-shadow:
      0 1px 3px 0 rgba(0, 0, 0, 0.1),
      0 1px 2px 0 rgba(0, 0, 0, 0.06);
    border: none;
  }
  .panel-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin-bottom: 1rem;
    color: #92400e;
  }
  .drafts-ready-panel .panel-title {
    color: #111827;
    font-size: 1.5rem;
  }
  .panel-message {
    margin-bottom: 1.5rem;
    color: #b45309;
  }
  .drafts-ready-panel .panel-message {
    color: #4b5563;
  }
  .btn-connect,
  .btn-start-batch,
  .btn-scan {
    background-color: #2563eb;
    color: white;
    padding: 0.75rem 1.5rem;
    border-radius: 0.375rem;
    font-weight: 700;
    border: none;
    cursor: pointer;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
    transition: background-color 0.2s;
  }
  .btn-connect:hover,
  .btn-start-batch:hover,
  .btn-scan:hover {
    background-color: #1d4ed8;
  }

  .editor-layout {
    height: calc(100vh - 100px);
    margin-left: -1.5rem;
    margin-right: -1.5rem;
    display: flex;
    flex-direction: column;
  }
  .editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 1.5rem;
    background-color: white;
    border-bottom: 1px solid #e5e7eb;
    gap: 1rem;
  }
  .editor-progress-section {
    flex: 1;
  }
  .progress-info {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.25rem;
  }
  .editor-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 0;
  }
  .progress-stats {
    font-size: 0.875rem;
    color: #6b7280;
  }
  .progress-track {
    width: 100%;
    background-color: #e5e7eb;
    border-radius: 9999px;
    height: 0.625rem;
  }
  .progress-fill {
    background-color: #2563eb;
    height: 100%;
    border-radius: 9999px;
    transition: width 0.5s;
  }

  .empty-batch-panel {
    background-color: #f9fafb;
    padding: 2rem;
    border-radius: 0.5rem;
    border: 1px dashed #d1d5db;
    text-align: center;
  }
  .empty-panel-title {
    font-size: 1.25rem;
    font-weight: 500;
    margin-bottom: 1rem;
    color: #6b7280;
  }
  .photo-warning-box {
    margin-bottom: 1rem;
    color: #ea580c;
    background-color: #fff7ed;
    padding: 1rem;
    border-radius: 0.375rem;
    display: inline-block;
    text-align: left;
    max-width: 32rem;
  }
  .warning-title {
    font-weight: 700;
  }
  .warning-action {
    margin-top: 0.5rem;
  }
  .warning-link {
    text-decoration: underline;
    font-weight: 700;
  }

  .scan-controls-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    width: 100%;
  }
  .scan-progress-wrapper {
    width: 100%;
    max-width: 28rem;
  }
  .stall-warning-box {
    margin-top: 1rem;
    padding: 1rem;
    background-color: #fff7ed;
    border: 1px solid #fed7aa;
    border-radius: 0.375rem;
  }
  .stall-message {
    color: #9a3412;
    font-size: 0.875rem;
    margin-bottom: 0.75rem;
  }
  .btn-resume-scan {
    background-color: #ea580c;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 0.25rem;
    font-weight: 700;
    border: none;
    cursor: pointer;
    transition: background-color 0.2s;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  }
  .btn-resume-scan:hover {
    background-color: #c2410c;
  }
  .scan-actions {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
  }
  .btn-scan:hover {
    transform: scale(1.05);
  }

  .start-review-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
    padding: 0.5rem 1rem;
    background-color: #2563eb;
    color: white;
    border-radius: 0.375rem;
    font-weight: 600;
    border: none;
    cursor: pointer;
  }
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    width: 100%;
    max-width: 720px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }
  .prompt-modal {
    max-width: 720px;
    z-index: 2001;
    position: relative;
  }
  .prompt-backdrop {
    z-index: 2000;
  }
  .prompt-hint {
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: #6b7280;
  }
  .body-textarea {
    min-height: 320px;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85rem;
    width: 100%;
  }
  .btn-save {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: #2563eb;
    color: white;
    border: none;
    cursor: pointer;
  }
  .modal-title {
    font-weight: 600;
    font-size: 1.1rem;
  }
  .image-picker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 0.75rem;
    margin-top: 1rem;
    max-height: 420px;
    overflow: auto;
  }
  .image-picker-item {
    border: 1px solid #e5e7eb;
    background: white;
    padding: 0;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
  }
  :global(.image-picker-img) {
    width: 100%;
    height: 90px;
    object-fit: cover;
    display: block;
  }
  .image-picker-item:hover {
    border-color: #3b82f6;
    box-shadow: 0 0 0 1px #3b82f6;
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

  .ai-btn {
    background: white;
    border: 1px solid #d1d5db;
    padding: 0.25rem 0.75rem;
    border-radius: 4px;
    font-size: 0.85rem;
    cursor: pointer;
    color: #374151;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }
  .ai-btn:hover {
    border-color: #10b981;
    color: #059669;
  }
  .ai-btn.icon-only {
    padding: 0;
    width: 32px;
    height: 32px;
    font-size: 1.1rem;
  }
</style>
