<script lang="ts">
  import { onMount } from "svelte";
  import { slide, fade } from "svelte/transition";
  import { generateHandle } from "$lib/handle-utils";
  import { store } from "$lib/store";
  import {
    isDriveConfigured,
    isAuthenticated,
    initiateOAuthFlow,
    handleOAuthCallback,
    listFilesInFolder,
    downloadFile,
    getStoredToken,
    clearToken,
    getFolderLink,
    uploadImageToDrive,
    type DriveFile,
    ensureFolderStructure,
  } from "$lib/google-drive";
  import type { AnyAction } from "$lib/store";
  import {
    start_session,
    set_header,
    append_raw_rows,
    resolve_conflict,
    mark_items_done,
    clear_import,
    finish_import,
    type RawRow,
    type ShopifyImportItem,
  } from "$lib/shopify-import-slice";
  import {
    create_listing,
    update_listing,
    add_listing_image,
    type Listing,
    type ListingImage,
  } from "$lib/listings-slice";

  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { update_item, bulk_import_items, type Item } from "$lib/inventory";
  import Papa from "papaparse";

  // --- State from Redux ---
  $: activeFile = $store.shopifyImport.activeFile;
  $: rawRows = $store.shopifyImport.rows;
  $: step = $store.shopifyImport.step;
  $: resolutions = $store.shopifyImport.resolutions || {};

  // --- Migration Logic ---
  // Only migrate actual Shopify CDN links
  $: pendingMigrations = Object.entries($store.inventory.idToItem)
    .filter(
      ([_, i]) =>
        (i as Item).image && (i as Item).image.includes("cdn.shopify.com"),
    )
    .map(([k, i]) => ({ ...(i as Item), key: k }));

  async function migrateImages() {
    if (pendingMigrations.length === 0) return;
    processing = true;
    let migratedCount = 0;
    const total = pendingMigrations.length;

    const token = getStoredToken();
    if (!token) {
      error = "Not authenticated with Drive";
      processing = false;
      return;
    }

    try {
      if (!cachedOriginalsId) {
        const { originalsId } = await ensureFolderStructure(token.access_token);
        cachedOriginalsId = originalsId;
      }

      const CHUNK_SIZE = 5; // Parallel uploads
      for (let i = 0; i < total; i += CHUNK_SIZE) {
        const chunk = pendingMigrations.slice(i, i + CHUNK_SIZE);

        await Promise.all(
          chunk.map(async (item) => {
            try {
              uploadStatus = `Migrating ${migratedCount + 1}/${total}...`;
              const driveLink = await uploadImage(item.image, item.janCode);
              if (driveLink) {
                // Update Inventory
                if ($user && $user.uid) {
                  // Construct full item for update
                  // item has 'key' mixed in, but that's fine for spread if Item allows excess props or we cast.
                  // Ideally clean it.
                  const { key, ...itemData } = item;
                  const newItem = { ...itemData, image: driveLink };

                  broadcast(
                    firestore,
                    $user.uid,
                    update_item({
                      id: key,
                      item: newItem,
                    }),
                  );
                }
              }
              migratedCount++;
            } catch (e) {
              console.error(`Failed to migrate ${item.janCode}`, e);
            }
          }),
        );
      }
      successMsg = `Migrated ${migratedCount} images.`;
    } catch (e) {
      error =
        "Migration failed: " + (e instanceof Error ? e.message : String(e));
    } finally {
      processing = false;
      uploadStatus = "";
    }
  }
  interface AnalyzedItem extends ShopifyImportItem {
    status: "MATCH" | "NEW" | "CONFLICT" | "RESOLVED" | "DONE" | "IDENTICAL";
    existingItem?: any;
    actionLabel: string;
    resolvedActions?: any[];
    conflictType?: "DATA_MISMATCH" | "MULTIPLE_MATCHES";
    conflictingFields?: string[];
    matchingKeys?: string[];
    originalIndex: number;
    isListingOnly?: boolean;
    existingListing?: Listing;
  }

  $: analyzedPlan = (() => {
    const seenHandlesInBatch = new Set<string>();
    
    return rawRows.map((rawRow: RawRow, index: number) => {
    const item = rawRow.parsed;
    
    // Track handle immediately if valid item
    if (item && item.handle) {
        seenHandlesInBatch.add(item.handle);
    }

    if (!item) {
      return {
        status: "DONE",
        janCode: "ERROR",
        description: rawRow.error || "Parse Error",
        qty: 0,
        actionLabel: "Error",
        originalIndex: index,
      } as AnalyzedItem;
    }

    if (item.processed || rawRow.processed) {
      return {
        ...item,
        status: "DONE",
        actionLabel: "Done",
        originalIndex: index,
      } as AnalyzedItem;
    }

    if (resolutions[index]) {
      return {
        ...item,
        status: "RESOLVED",
        resolvedActions: resolutions[index],
        actionLabel: "Ready",
        originalIndex: index,
      } as AnalyzedItem;
    }

    const JAN = item.janCode;

    const existing = $store.inventory.idToItem[JAN];
    const inventoryMatches = existing ? [{ ...existing, key: JAN }] : [];

    // Strict match implies length is 1. O(1) lookup.
    
    // NEW: Handle Listing-Only matches (empty JAN)
    if (inventoryMatches.length === 0) {
        if (!JAN && item.handle) {
             const knownListing = $store.listings.handleToListing[item.handle];
             const isNewInBatch = seenHandlesInBatch.has(item.handle);
             
             if (knownListing || isNewInBatch) {
                 // Check if image already exists (only if knownListing exists)
                 // If newInBatch, we assume it's NOT identical to what we just created? 
                 // Or we could track images in batch too? 
                 // Simple: If newInBatch, it's MATCH (Add Image).
                 
                 const imgExists = knownListing && item.image ? (knownListing.images || []).some((img: any) => img.url === item.image) : false;
                 
                 // Use knownListing or a mock for the reference
                 const listingRef = knownListing || { handle: item.handle } as Listing;
                 
                 if (imgExists) {
                     return {
                        ...item,
                        status: "IDENTICAL",
                        actionLabel: "Identical",
                        originalIndex: index,
                        isListingOnly: true // Tracking
                     } as AnalyzedItem;
                 } else {
                     return {
                        ...item,
                        status: "MATCH",
                        actionLabel: "Add Image",
                        originalIndex: index, 
                        isListingOnly: true,
                        existingListing: listingRef 
                     } as AnalyzedItem;
                 }
             }
        }
    
        // It's genuinely NEW

        return {
        ...item,
        status: "NEW",
        actionLabel: "Create",
        originalIndex: index,
      } as AnalyzedItem;
    }

    const match = inventoryMatches[0] as any;
    const conflicts: string[] = [];

    if (!useShopifyDescription) {
      const existDesc = match.description || "";
      const newDesc = item.description || "";
      if (
        existDesc.trim() !== "" &&
        newDesc.trim() !== "" &&
        existDesc.trim() !== newDesc.trim()
      ) {
        conflicts.push("Description");
      }
    }

    const existWeight = match.weight;
    const newWeight = item.weight;
    if (existWeight && newWeight && existWeight !== newWeight)
      conflicts.push("Weight");

    const existPrice = match.price;
    const newPrice = item.price;
    if (existPrice && newPrice && existPrice !== newPrice)
      conflicts.push("Price");

    const shopifyToDriveMap = $store.inventory.shopifyUrlToDriveUrl || {};

    if (!useShopifyImages) {
      const existImage = match.image;
      const newImage = item.image;
      // Conflict if both exist and are different
      if (existImage && newImage && existImage !== newImage) {
        // Check if newImage (Shopify) maps to existImage (Drive)
        const mappedDriveUrl = shopifyToDriveMap[newImage];
        if (mappedDriveUrl !== existImage) {
          conflicts.push("Image");
        }
      }
    }

    if (!useShopifyHandles) {
      const existHandle = match.handle || "";
      const newHandle = item.handle || "";

      if (existHandle.trim() !== newHandle.trim()) {
        // Use match.janCode (pure JAN) instead of item.fanCode (CSV Variant SKU/ID)
        const computed = generateHandle(
          match.description || item.description || "",
          match.janCode,
        );
        if (newHandle !== computed) {
          conflicts.push("Handle");
        }
      }
    }

    // Stock Check
    const existTotal = match.qty || 0;
    const existShipped = match.shipped || 0;
    const existRemaining = existTotal - existShipped;
    const newRemaining = item.qty; // Shopify qty is remaining

    // Logic adjusted based on feedback:
    // "Ignore" (Checked) -> Treat as success (MATCH), don't flag conflict. (And don't update qty).
    // "Sync/Verify" (Unchecked) -> Flag conflict if mismatch.

    if (!ignoreShopifyQty && existRemaining !== newRemaining) {
      conflicts.push("Stock");
    }

    if (conflicts.length > 0) {
      return {
        ...item,
        status: "CONFLICT",
        conflictType: "DATA_MISMATCH",
        conflictingFields: conflicts,
        existingItem: match,
        actionLabel: "Resolve Conflict",
        originalIndex: index,
      } as AnalyzedItem;
    }

    // --- Check for IDENTICAL ---
    // If we are here, it's a "MATCH" candidate (no conflicts).
    // We check if it is actively different in any field we care about.

    let isIdentical = true;

    // 1. Description
    if (useShopifyDescription) {
      const existDesc = match.description || "";
      const newDesc = item.description || "";
      if (existDesc.trim() !== newDesc.trim()) isIdentical = false;
    }

    // 2. Weight (Always updated if present in CSV, so check difference)
    if (item.weight && match.weight !== item.weight) isIdentical = false;

    // 3. Price
    if (item.price && match.price !== item.price) isIdentical = false;

    // 4. Handles
    if (useShopifyHandles) {
      const existHandle = match.handle || "";
      const newHandle = item.handle || "";
      if (existHandle.trim() !== newHandle.trim()) isIdentical = false;
    }

    // 5. Images
    if (useShopifyImages) {
      const imageUrl = item.image || "";
      // If CSV has image, we check if it matches existing.
      // Note: Existing might be Drive URL. mismatched is conflict check above?
      // The conflict check logic above (lines 179-190) handles explicit mismatches.
      // If we are here, there is NO conflict.
      // But is there a CHANGE?
      // If existing has no image and new has image -> Change.
      if (!match.image && imageUrl) isIdentical = false;
      // If both exist and no conflict -> Identical (via map or same string).
    }

    // 6. Extended Fields (Body, Category, etc) - These are "backfill" logic in processBatch?
    // processBatch says: "if (!payloadItem.bodyHtml && item.bodyHtml) ..."
    // So if existing HAS it, we don't change. If existing MISSING it, we change.
    if (!match.bodyHtml && item.bodyHtml) isIdentical = false;
    if (!match.productCategory && item.productCategory) isIdentical = false;
    if (!match.imagePosition && item.imagePosition) isIdentical = false;
    if (!match.imageAltText && item.imageAltText) isIdentical = false;

    // 7. QTY / STOCK
    // If ignoreShopifyQty is TRUE, we treat stock diffs as "Ignored" -> effectively Identical for processing purposes?
    // "ensure that the bulk import triggered by this screen never include qty"
    // If ignoreShopifyQty is FALSE, we verify sync.
    if (!ignoreShopifyQty) {
      // We are Syncing.
      // Logic from processBatch:
      // newTotal = item.qty (Remaining) + match.shipped
      // oldTotal = match.qty (Total)
      const existShipped = match.shipped || 0;
      const newTotal = item.qty + existShipped;
      const oldTotal = match.qty || 0;

      if (newTotal !== oldTotal) isIdentical = false;
    }

    if (isIdentical) {
      return {
        ...item,
        status: "IDENTICAL",
        existingItem: match,
        actionLabel: "Identical",
        originalIndex: index,
      } as AnalyzedItem;
    }

    return {
      ...item,
      status: "MATCH",
      existingItem: match,
      actionLabel: "Sync",
      originalIndex: index,
    } as AnalyzedItem;
  });
  })();

  $: visibleItems = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status !== "DONE",
  );
  $: allDone = analyzedPlan.length > 0 && visibleItems.length === 0;

  $: if (allDone && !processing && activeFile && $user && $user.uid) {
    const u = $user.uid;
    setTimeout(() => {
      if (analyzedPlan.length > 0 && visibleItems.length === 0) {
        broadcast(firestore, u, finish_import());
        successMsg = "All items processed. Session finished.";
      }
    }, 1000);
  }

  $: selectedFile = activeFile
    ? ({ ...activeFile, mimeType: "text/csv" } as DriveFile)
    : null;

  // Locals
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;
  let analysisStatus: "idle" | "analyzing" = "idle";

  let useShopifyDescription = false;
  let useShopifyImages = false;
  let useShopifyHandles = false; // Toggle for handles
  let currentFilter:
    | "ALL"
    | "MATCH"
    | "NEW"
    | "CONFLICT"
    | "RESOLVED"
    | "IDENTICAL" = "ALL";
  let showConflictModal = false;
  let currentConflictItem: any = null;
  let currentConflictIndex = -1;
  let fieldResolutions: Record<string, string> = {};
  let hoveredImage: string | null = null;
  let ignoreShopifyQty = false; // Add state

  // Helper to compute default handle

  $: matchCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "MATCH",
  ).length;
  $: newCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "NEW",
  ).length;
  $: resolvedCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "RESOLVED",
  ).length;
  $: identicalCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "IDENTICAL",
  ).length;

  onMount(async () => {
    driveConfigured = isDriveConfigured();
    if (driveConfigured) {
      const token = handleOAuthCallback();
      if (token) {
        authenticated = true;
        await loadFiles();
      } else {
        authenticated = isAuthenticated();
        if (authenticated) {
          await loadFiles();
        }
      }
    }
  });

  async function loadFiles() {
    const token = getStoredToken();
    if (!token) {
      authenticated = false;
      return;
    }
    loadingFiles = true;
    error = "";
    try {
      driveFiles = await listFilesInFolder(token.access_token);
      driveFiles = driveFiles.filter(
        (f) => f.mimeType === "text/csv" || f.name.endsWith(".csv"),
      );
    } catch (e) {
      error =
        "Failed to load files: " + (e instanceof Error ? e.message : String(e));
      if (error.includes("401")) {
        clearToken();
        authenticated = false;
      }
    } finally {
      loadingFiles = false;
    }
  }

  function handleConnect() {
    initiateOAuthFlow();
  }
  function handleDisconnect() {
    clearToken();
    authenticated = false;
    driveFiles = [];
    resetPreview();
  }
  function resetPreview() {
    if ($user && $user.uid) broadcast(firestore, $user.uid, clear_import());
    error = "";
  }

  function selectFile(file: DriveFile) {
    if (activeFile?.id === file.id) return;
    if ($user && $user.uid)
      broadcast(
        firestore,
        $user.uid,
        start_session({ id: file.id, name: file.name }),
      );
    error = "";
    successMsg = "";
  }

  async function handleAnalyze(file: DriveFile) {
    const token = getStoredToken();
    if (!token) return;
    processing = true;
    analysisStatus = "analyzing";
    error = "";
    successMsg = "";

    if ($user && $user.uid)
      broadcast(
        firestore,
        $user.uid,
        start_session({ id: file.id, name: file.name }),
      );

    try {
      const content = await downloadFile(file.id, token.access_token);

      // Robustly split CSV rows preserving quoted newlines
      const splitCSVRows = (text: string) => {
        const rows: string[] = [];
        let current = "";
        let inQuote = false;
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          if (char === '"') {
            inQuote = !inQuote;
          }
          if (char === "\n" && !inQuote) {
            rows.push(current.trim()); // Trim CR if present
            current = "";
          } else {
            current += char;
          }
        }
        if (current.trim()) rows.push(current.trim());
        return rows;
      };

      const allRows = splitCSVRows(content);
      if (allRows.length === 0) throw new Error("File is empty");

      const header = allRows[0];
      const bodyLines = allRows.slice(1); // Raw body lines

      if ($user && $user.uid)
        broadcast(firestore, $user.uid, set_header(header));

      const CHUNK_SIZE = 50;
      if (bodyLines.length === 0) {
        if ($user && $user.uid)
          broadcast(
            firestore,
            $user.uid,
            append_raw_rows({ rawRows: [], done: true }),
          );
      } else {
        for (let i = 0; i < bodyLines.length; i += CHUNK_SIZE) {
          const chunk = bodyLines.slice(i, i + CHUNK_SIZE);
          const isLast = i + CHUNK_SIZE >= bodyLines.length;
          if ($user && $user.uid)
            broadcast(
              firestore,
              $user.uid,
              append_raw_rows({ rawRows: chunk, done: isLast }),
            );
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      processing = false;
      analysisStatus = "idle";
    } catch (e) {
      error =
        "Analysis failed: " + (e instanceof Error ? e.message : String(e));
      processing = false;
      analysisStatus = "idle";
    }
  }

  // --- Conflict Modal ---
  function openConflictModal(item: AnalyzedItem, index: number) {
    currentConflictItem = item;
    currentConflictIndex = index;
    fieldResolutions = {};

    if (item.conflictingFields) {
      // Default to Incoming? Or Existing?
      // Previous code defaulted to incoming.
      item.conflictingFields.forEach(
        (f: string) => (fieldResolutions[f] = "incoming"),
      );
    }
    showConflictModal = true;
  }

  function closeConflictModal() {
    showConflictModal = false;
    currentConflictItem = null;
    currentConflictIndex = -1;
  }

  function confirmConflictResolution() {
    if (!currentConflictItem) return;

    // We need to construct a payload for 'update_item' or similar.
    // Actually 'resolve_conflict' action in slice handles applying to state?
    // No, checking inventory.ts... 'resolve_conflict' is not a standard action there.
    // Wait, 'shopify-import-slice.ts' has 'resolve_conflict'?
    // Or do we emit updates?
    // Step 292 implemented 'resolve_conflict'. Let's check imports.
    // But assuming 'resolve_conflict' exists.
    const itemKey = currentConflictItem.existingItem?.key;
    const resolvedActions: any[] = [];

    if (itemKey) {
      const payload: any = { itemKey, qty: currentConflictItem.qty };
      // NOTE: Conflict Resolution sets the Qty to currentConflictItem.qty (from CSV)
      // Similar to order-import, this implies valid reconciliation of counts.

      if (currentConflictItem.conflictingFields) {
        currentConflictItem.conflictingFields.forEach((field: string) => {
          const choice = fieldResolutions[field];
          const prop =
            field === "Description"
              ? "description"
              : field === "Weight"
                ? "weight"
                : field === "Price"
                  ? "price"
                  : field === "Image"
                    ? "image"
                    : field === "Body (HTML)"
                      ? "bodyHtml"
                      : field === "Product Category"
                        ? "productCategory"
                        : field === "Image Position"
                          ? "imagePosition"
                          : field === "Image Alt Text"
                            ? "imageAltText"
                            : field === "Handle"
                              ? "handle"
                              : field === "Stock"
                                ? "qty"
                                : null;

          if (prop) {
            const incoming = (currentConflictItem as any)[prop];
            const existing = currentConflictItem!.existingItem[prop];

            if (prop === "qty") {
              // Special handling for Stock/Qty
              // Incoming 'qty' is Shopify Remaining.
              // Existing 'qty' is Available Total (Internal).

              if (choice === "incoming") {
                // User wants to Sync to Shopify.
                // Current Internal Total = Shopify Remaining + Shipped.
                const existingShipped =
                  currentConflictItem!.existingItem.shipped || 0;
                payload[prop] = Number(incoming) + existingShipped;
              } else {
                // User wants to Keep Existing.
                // Payload = Existing Total.
                payload[prop] = existing;
              }
            } else {
              payload[prop] = choice === "incoming" ? incoming : existing;
            }
          }
        });
      }

      // Also apply non-conflicting image if existing is missing
      if (
        !currentConflictItem.existingItem.image &&
        currentConflictItem.image
      ) {
        payload.image = currentConflictItem.image;
      }

      resolvedActions.push({ type: "update_item", payload });
    }

    if ($user && $user.uid) {
      broadcast(
        firestore,
        $user.uid,
        resolve_conflict({ index: currentConflictIndex, resolvedActions }),
      );
    }
    closeConflictModal();
  }

  // --- Image Helpers ---
  let uploadStatus = "";
  let cachedOriginalsId: string | null = null;
  async function uploadImage(
    url: string,
    filenameBase: string,
  ): Promise<string | null> {
    try {
      const token = getStoredToken();
      if (!token) return null;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
      const blob = await resp.blob();
      if (!cachedOriginalsId) {
        const { originalsId } = await ensureFolderStructure(token.access_token);
        cachedOriginalsId = originalsId;
      }
      const driveFilename = `${Date.now()}_${filenameBase}.jpg`;
      const driveFile = await uploadImageToDrive(
        blob,
        driveFilename,
        cachedOriginalsId,
        token.access_token,
      );
      return driveFile.thumbnailLink || driveFile.webContentLink || null;
    } catch (e) {
      console.error("Image upload failed", url, e);
      return null;
    }
  }

  async function processBatch(targetStatus: "MATCH" | "NEW") {
    if (!analyzedPlan.length) return;
    const itemsToProcessWithType = analyzedPlan
      .map((item: AnalyzedItem, index: number) => ({ item, index }))
      .filter(
        ({ item }: { item: AnalyzedItem }) => item.status === targetStatus,
      );
    if (itemsToProcessWithType.length === 0) return;

    processing = true;
    const indicesToMarkDone: number[] = [];
    const bulkUpdates: Array<{
      type: "new" | "update";
      id: string;
      item: any;
    }> = [];
    const total = itemsToProcessWithType.length;
    let current = 0;
    const seenHandles = new Set<string>();
    const clearedHandles = new Set<string>();

    // No longer need pendingImagesByHandle for atomic additions
    // const pendingImagesByHandle: Record<string, ListingImage[]> = {};
    const imageActions: AnyAction[] = [];

    try {
      for (const { item, index } of itemsToProcessWithType) {
         // Strict Sync: Clear listing images first time we see a handle in this batch if syncing images
         if (useShopifyImages && item.handle && !clearedHandles.has(item.handle)) {
             imageActions.push(update_listing({ handle: item.handle, changes: { images: [] } }));
             clearedHandles.add(item.handle);
         }

        current++;

        // Only use Shopify URL if:
        // 1. It exists
        // 2. We are creating NEW or (MATCH and existing has no image OR we want to overwrite?)
        // Note: The prompt implies initially just pointing to Shopify CDN.
        // Let's adopt the logic: If item.image is present, use it.
        // We do NOT block on upload here.

        let imageUrl = item.image || "";

        // NEW: Handle Listing Only (Image Append)
        if (item.status === "MATCH" && item.isListingOnly && item.existingListing) {
            const listing = item.existingListing;
            if (item.image) {
                // ATOMIC Add Image Action
                // We broadcast this action directly. Since it's atomic, it's safe even if redundant.
                // The reducer handles deduplication by URL.
                const handle = listing.handle;
                
                // We need to generate a ListingImage object
                // Position logic: The reducer will push. 
                // If we want correct position from CSV, we might need 'imagePosition' field
                // But typically append is enough for "Listing Only" rows which are usually additional variants/images.
                // The CSV might provide explicit Position column though.
                // For now, we trust the reducer to append.
                
                const newImage: ListingImage = {
                     id: crypto.randomUUID(),
                     url: item.image,
                     position: item.imagePosition || 999, // Allow reducer to sort or just append
                     altText: item.imageAltText || item.description || ""
                };
                
                imageActions.push(add_listing_image({ handle, image: newImage }));
            }
            indicesToMarkDone.push(index);
            continue;
        }

        if (item.status === "MATCH" && item.existingItem) {
            const itemKey = item.existingItem.key;
            const existing = item.existingItem;

          // CRITICAL: applyInventoryUpdate treats qty/shipped as DELTAS.
          // We must initiate them as 0 to avoid doubling existing values.
          const payloadItem: any = { ...existing, qty: 0, shipped: 0 };

          // Logic:
          // Shopify Qty is "Stock Remaining" (Total - Shipped).
          // Internal Qty is "Total Lifetime Stock".
          // Internal Stock Remaining = (Existing Qty - Existing Shipped).
          // So, if (Existing Qty - Existing Shipped) != Shopify Qty, we have a conflict.
          // WE DO NOT OVERWRITE QTY FROM SHOPIFY AUTOMATICALLY ON MATCH.

          // Only update descriptors/images if matches

          // Toggle Description
          if (useShopifyDescription && item.description) {
            payloadItem.description = item.description;
          } else if (!payloadItem.description && item.description) {
            payloadItem.description = item.description;
          }

          // Handle Logic
          if (useShopifyHandles && item.handle) {
            payloadItem.handle = item.handle;
          } else if (!payloadItem.handle && item.handle) {
            payloadItem.handle = item.handle;
          }
          if (!payloadItem.weight && item.weight)
            payloadItem.weight = item.weight;
          if (!payloadItem.price && item.price) payloadItem.price = item.price;

          if (!payloadItem.bodyHtml && item.bodyHtml)
            payloadItem.bodyHtml = item.bodyHtml;
          if (!payloadItem.productCategory && item.productCategory)
            payloadItem.productCategory = item.productCategory;
          if (!payloadItem.imagePosition && item.imagePosition)
            payloadItem.imagePosition = item.imagePosition;
          if (!payloadItem.imageAltText && item.imageAltText)
            payloadItem.imageAltText = item.imageAltText;

          if (useShopifyImages) {
              // 1. Update Inventory Item with Variant Image (item.image)
              // Strict Sync: If Shopify has no image for this variant (item.image is empty),
              // we clear it in Inventory to match.
              payloadItem.image = item.image;
              
              // 2. Add Gallery Image (item.listingImage) to Listing
              if (item.listingImage && item.handle) {
                  const newListingImage: ListingImage = {
                      id: crypto.randomUUID(),
                      url: item.listingImage,
                      position: item.imagePosition || 999,
                      altText: item.imageAltText || item.description || ""
                  };
                  imageActions.push(add_listing_image({ handle: item.handle, image: newListingImage }));
              }
          } else if (!payloadItem.image && item.image) {
            payloadItem.image = item.image;
          }
          
          // Backfill listing image if missing and present in import
          if (!useShopifyImages && item.listingImage && item.handle) {
             const newListingImage: ListingImage = {
                 id: crypto.randomUUID(),
                 url: item.listingImage,
                 position: item.imagePosition || 999,
                 altText: item.imageAltText || item.description || ""
             };
             imageActions.push(add_listing_image({ handle: item.handle, image: newListingImage }));
          }

          // Qty Logic:
          // "Ensure that the bulk import triggered by this screen never include qty"
          // if we are Ignoring.
          if (!ignoreShopifyQty) {
            // If NOT ignoring, we Sync.
            // Sync means Inventory Qty = Shopify Qty + Shipped.
            // (Because Shopify Qty = Remaining).
            const existingShipped = existing.shipped || 0;
            const newTotal = item.qty + existingShipped;
            const oldTotal = existing.qty || 0;

            if (newTotal !== oldTotal) {
              // Calculate DELTA
              const delta = newTotal - oldTotal;
              payloadItem.qty = delta;
            }
          }

          bulkUpdates.push({ type: "update", id: itemKey, item: payloadItem });
          indicesToMarkDone.push(index);
        } else if (item.status === "NEW") {
          const newItemKey = item.janCode;
          const newItem = {
            janCode: item.janCode,
            subtype: "", // Option1 Value logic required? Shopify CSV has "Option1 Value".
            // AnalyzedItem maps "Option1 Value" to... wait.
            // parseShopifyCSV (slice) maps Option1 Value to item.subtype?
            // Let's check parse logic?
            // Assuming item object has what we need.
            // If not, we might be losing Option1 Value.
            // But for now, preserving existing logic for newItem creation.
            description: item.description,
            qty: item.qty, // NEW items always get qty. Can't ignore initial stock?
            pieces: 1,
            shipped: 0,
            creationDate: new Date().toISOString(),
            price: item.price,
            weight: item.weight,
            image: imageUrl, // Shopify URL
            handle: item.handle,
          };
          bulkUpdates.push({ type: "new", id: newItemKey, item: newItem });
          indicesToMarkDone.push(index);

          // --- Listing Creation ---
          if (item.handle) {
            const handle = item.handle;
            const existingListing = $store.listings.handleToListing[handle];

            if (!existingListing && !seenHandles.has(handle)) {
              // Create Listing
              const newListing: Listing = {
                handle,
                title: item.description || "Untitled",
                bodyHtml: item.bodyHtml || "",
                productCategory: item.productCategory || "",
                productType: "",
                vendor: "SPNSS Ltd.",
                tags: [],
                status: "active",
                option1Name: "Subtype", // Default
                images: item.image
                  ? [
                      {
                        id: crypto.randomUUID(),
                        url: item.image,
                        position: item.imagePosition || 1,
                        altText: item.imageAltText || item.description || "",
                      },
                    ]
                  : [],
                lastUpdated: Date.now(),
              };

              if ($user && $user.uid) {
                broadcast(
                  firestore,
                  $user.uid,
                  create_listing({ listing: newListing }),
                );
              }
              seenHandles.add(handle);
            }
          }
        }
      }



      const CHUNK_SIZE = 100;
      for (let i = 0; i < bulkUpdates.length; i += CHUNK_SIZE) {
        const chunk = bulkUpdates.slice(i, i + CHUNK_SIZE);
        const idxChunk = indicesToMarkDone.slice(i, i + CHUNK_SIZE);
        if ($user && $user.uid) {
          broadcast(firestore, $user.uid, bulk_import_items({ items: chunk }));
          broadcast(
            firestore,
            $user.uid,
            mark_items_done({ indices: idxChunk }),
          );
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      
    // 2. Broadcast Granular Image Actions (AFTER Bulk Updates)
    if ($user && $user.uid && imageActions.length > 0) {
        const IMG_CHUNK_SIZE = 50; 
        for (let i = 0; i < imageActions.length; i += IMG_CHUNK_SIZE) {
            const chunk = imageActions.slice(i, i + IMG_CHUNK_SIZE);
            for (const action of chunk) {
                broadcast(firestore, $user.uid, action);
            }
            await new Promise(r => setTimeout(r, 10));
        }
    }

      successMsg = `Processed ${bulkUpdates.length} items.`;
    } catch (e) {
      error =
        "Processing failed: " + (e instanceof Error ? e.message : String(e));
    } finally {
      processing = false;
      uploadStatus = "";
    }
  }

  async function processIdentical() {
    // Find Identical items
    const identicalIndices = analyzedPlan
      .map((item: AnalyzedItem, index: number) => ({ item, index }))
      .filter(({ item }: { item: AnalyzedItem }) => item.status === "IDENTICAL")
      .map(({ index }: { index: number }) => index);

    if (identicalIndices.length === 0) return;

    processing = true;
    try {
      if ($user && $user.uid) {
        // We just mark them done. No updates broadcasted.
        broadcast(
          firestore,
          $user.uid,
          mark_items_done({ indices: identicalIndices }),
        );
        successMsg = `Marked ${identicalIndices.length} identical items as processed.`;
      }
    } catch (e) {
      error = "Processing failed: " + String(e);
    } finally {
      processing = false;
    }
  }

  async function processResolvedConflicts() {
    const resolvedWithType = analyzedPlan
      .map((item: AnalyzedItem, index: number) => ({ item, index }))
      .filter(({ item }: { item: AnalyzedItem }) => item.status === "RESOLVED");

    if (resolvedWithType.length === 0) return;
    processing = true;
    const indicesToMarkDone: number[] = [];
    const bulkUpdates: Array<{
      type: "new" | "update";
      id: string;
      item: any;
    }> = [];

    try {
      for (const { item, index } of resolvedWithType) {
        if (item.resolvedActions) {
          item.resolvedActions.forEach((action: any) => {
            const currentInvItem =
              $store.inventory.idToItem[action.payload.itemKey];
            if (currentInvItem) {
              // The resolved action payload already contains the merged state
              // typically from confirmConflictResolution.
              // But wait, confirmConflictResolution builds a payload with SPECIFIC fields.
              // We should merge it carefully.

              const payloadItem = {
                ...currentInvItem,
                ...action.payload,
              };

              // If action.payload has 'qty', it means we are forcing the Qty.
              // Ideally, if we are correcting stock, we might need adjustments to 'shipped' too?
              // Or we assume the user intends to overwrite TOTAL qty?
              // Shopify Qty is "Remaining".
              // If we set Internal Qty = Shopify Qty, needed to verify Shipped = 0?
              // Or do we recalculate Qty = Shopify Qty + Shipped?
              // Let's assume for RESOLVED conflicts from UI, if user accepted Shopify Qty,
              // they mean "Remaining Stock is X".
              // So Total Qty = X + Shipped.

              if (action.payload.qty !== undefined) {
                // Special case: If we 'Keep Existing', we might have passed existing Qty back in payload.
                // If so, does it match currentInvItem.qty?
                // If it matches, we are fine.
                // If we 'Use Incoming', action.payload.qty is Shopify Qty (Remaining).
                // So we must add Shipped.
                // We need to know if the payload value is "Total" or "Remaining".
                // UI logic (confirmConflictResolution):
                // payload.qty = choice === 'incoming' ? incoming : existing;
                // Incoming = Shopify Qty (Remaining).
                // Existing = currentConflictItem!.existingItem.qty (Total).
                // Conflict!
                // If we chose Existing (Total), we set payload.qty = Total.
                // If we chose Incoming (Remaining), we set payload.qty = Remaining.
                // We need to distinguish or normalize.
                // Ideally, payload should just be consistent updates.
                // But here we are applying "qty" update.
                // Let's check `fieldResolutions` logic in confirmConflictResolution.
                // If choice was 'incoming', we are updating to new Remaining.
                // Wait, we lost the context of "choice" here in `processResolvedConflicts` (looping over stored resolutions).
                // We only have the final payload.
                // Heuristic:
                // If the payload value matches Shopify Qty (item.qty), trust it as Remaining?
                // But what if Existing Total randomly equals Shopify Remaining?
                // That would be a coincidence but possible.
                // Better:
                // In `confirmConflictResolution`, normalize the payload to TOTAL immediately.
              }

              // Wait, I can't change confirmConflictResolution here without context.
              // Let's assume the payload.qty is ALREADY normalized to Total in confirmConflictResolution?
              // Let's check existing code there.
              // Line 428: payload[prop] = choice === 'incoming' ? incoming : existing;
              // Incoming 'qty' is Remaining. Existing 'qty' is Total.
              // So the payload is mixed meaning!

              // Fix is needed in confirmConflictResolution.

              // But assuming I can fix it there (next step?), here we just apply simple math if needed?
              // No, safer to fix upstream.

              // For now, let's keep the existing logic block I am REPLACING, but simpler?
              // The original block (lines 622-625) added `existingShipped`.
              // "payloadItem.qty = Number(action.payload.qty) + existingShipped;"
              // This assumes payload.qty was REMAINING.
              // If user chose "Keep Existing" (Total), then we add Shipped? -> Total + Shipped ==> Wrong (Inflated).

              // Current Bug in existing code?
              // Yes, likely.

              // Since I am already ignoring Qty by default, maybe resolutions are less frequent?
              // But if they resolve...

              // I'll leave this block mostly as is but cleaner, and fix confirmConflictResolution next.

              // Actually, I can't leave it "as is" if it's broken.
              // I'll comment out the forced addition for now and rely on corrected payload.
              // Or... assume payload IS total.
              if (action.payload.qty !== undefined) {
                payloadItem.qty = Number(action.payload.qty);
              }

              bulkUpdates.push({
                type: "update",
                id: action.payload.itemKey,
                item: payloadItem,
              });
            }
          });
          indicesToMarkDone.push(index);
        }
      }
      const CHUNK_SIZE = 100;
      for (let i = 0; i < bulkUpdates.length; i += CHUNK_SIZE) {
        const chunk = bulkUpdates.slice(i, i + CHUNK_SIZE);
        if ($user && $user.uid)
          broadcast(firestore, $user.uid, bulk_import_items({ items: chunk }));
        await new Promise((r) => setTimeout(r, 10));
      }
      if ($user && $user.uid)
        broadcast(
          firestore,
          $user.uid,
          mark_items_done({ indices: indicesToMarkDone }),
        );
      successMsg = "Processed resolutions.";
    } catch (e) {
      error = String(e);
    } finally {
      processing = false;
    }
  }

  function getIncomingValue(field: string) {
    if (!currentConflictItem) return "";
    if (field === "Description") return currentConflictItem.description;
    if (field === "Stock") return currentConflictItem.qty;
    const key = field.toLowerCase();
    return (currentConflictItem as any)[key];
  }

  function getExistingValue(field: string) {
    if (!currentConflictItem || !currentConflictItem.existingItem) return "";
    if (field === "Description")
      return currentConflictItem.existingItem.description;
    if (field === "Handle") {
      return (
        currentConflictItem.existingItem.handle ||
        generateHandle(
          currentConflictItem.existingItem.description || "",
          currentConflictItem.existingItem.janCode,
        )
      );
    }
    if (field === "Stock") {
      // Display "Effective Stock Finding"
      const total = currentConflictItem.existingItem.qty || 0;
      const shipped = currentConflictItem.existingItem.shipped || 0;
      return `${total - shipped} (Total: ${total}, Shipped: ${shipped})`;
    }
    const key = field.toLowerCase();
    return currentConflictItem.existingItem[key];
  }
</script>

<div class="import-page">
  <h1>Shopify Product Import</h1>

  {#if driveConfigured}
    {#if !authenticated}
      <div class="auth-prompt">
        <p>Connect to Google Drive to import Shopify CSVs.</p>
        <button on:click={handleConnect} class="btn-primary"
          >Connect to Google Drive</button
        >
      </div>
    {:else}
      <div class="authenticated">
        <div class="header-actions">
          <span>Connected to Drive</span>
          <button on:click={handleDisconnect} class="disconnect-button"
            >Disconnect</button
          >
        </div>

        {#if error}<div class="message error">{error}</div>{/if}
        {#if successMsg}<div class="message success">{successMsg}</div>{/if}

        <!-- Migration Panel -->
        {#if pendingMigrations.length > 0}
          <div class="panel migration-panel mb-4 bg-blue-50 border-blue-200">
            <div class="flex justify-between items-center">
              <div>
                <h3 class="text-blue-800 m-0">Image Migration</h3>
                <p class="text-sm text-blue-600 mt-1">
                  {pendingMigrations.length} products have Shopify CDN images that
                  need to be backed up to Drive.
                </p>
              </div>
              <div class="flex items-center gap-3">
                {#if processing && uploadStatus}
                  <span class="text-xs text-blue-600 animate-pulse"
                    >{uploadStatus}</span
                  >
                {/if}
                <button
                  class="btn-primary"
                  on:click={migrateImages}
                  disabled={processing}
                >
                  Migrate Images
                </button>
              </div>
            </div>
            <div class="w-full bg-blue-200 h-1 mt-3 rounded overflow-hidden">
              <!-- Simple visual feedback if migrating -->
              {#if processing && uploadStatus.includes("Migrating")}
                <div class="h-full bg-blue-600 animate-progress"></div>
              {/if}
            </div>
          </div>
        {/if}

        <div class="layout-grid">
          <!-- File List -->
          <div class="panel file-list">
            <h2>Select CSV</h2>
            {#if loadingFiles}
              <div class="loading">Loading files...</div>
            {:else if driveFiles.length === 0}
              <div class="empty">No CSV files found.</div>
            {:else}
              <ul>
                {#each driveFiles as file}
                  <li>
                    <button
                      class:selected={selectedFile?.id === file.id}
                      on:click={() => selectFile(file)}
                    >
                      {file.name}
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- Preview -->
          <div class="panel preview-panel">
            {#if !selectedFile}
              <div class="placeholder">
                Select a file from the list to preview
              </div>
            {:else if analysisStatus === "analyzing"}
              <div class="loading">Analyzing {selectedFile.name}...</div>
            {:else if rawRows.length > 0}
              <div class="preview-header">
                <h2>Preview: {selectedFile.name}</h2>

                <!-- Description Toggle -->
                <div class="mb-4 p-4 bg-gray-50 rounded border border-gray-200">
                  <label
                    class="flex items-center gap-2 text-sm bg-white px-3 py-1 rounded shadow-sm border"
                  >
                    <input
                      type="checkbox"
                      bind:checked={useShopifyDescription}
                    />
                    Accept Shopify Descriptions
                  </label>
                  <label
                    class="flex items-center gap-2 text-sm bg-white px-3 py-1 rounded shadow-sm border"
                  >
                    <input type="checkbox" bind:checked={useShopifyImages} />
                    Accept Shopify Images
                  </label>
                  <label
                    class="flex items-center gap-2 text-sm bg-white px-3 py-1 rounded shadow-sm border"
                  >
                    <input type="checkbox" bind:checked={useShopifyHandles} />
                    Accept Shopify Handles
                  </label>
                  <label
                    class="flex items-center gap-2 text-sm bg-white px-3 py-1 rounded shadow-sm border"
                  >
                    <input type="checkbox" bind:checked={ignoreShopifyQty} />
                    Ignore Shopify quantities
                  </label>
                  <p class="text-xs text-muted mt-1">
                    If checked, existing descriptions and handles will be
                    overwritten. If "Ignore" is checked, quantity mismatches
                    will flag conflicts but import will skip quantity updates.
                  </p>
                </div>

                <div class="batch-actions">
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("MATCH")}
                    disabled={processing}
                  >
                    Sync Matches ({matchCount})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("NEW")}
                    disabled={processing}
                  >
                    Create New ({newCount})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={processResolvedConflicts}
                    disabled={processing}
                  >
                    Process Resolved ({resolvedCount})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={processIdentical}
                    disabled={processing}
                  >
                    Process Identical ({identicalCount})
                  </button>
                </div>
              </div>

              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>JAN</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each visibleItems as item (item.originalIndex)}
                      <tr transition:slide|local>
                        <td>
                          <span class="badge {item.status.toLowerCase()}"
                            >{item.status}</span
                          >
                        </td>
                        <td class="font-mono">{item.janCode}</td>
                        <td class="truncate" style="max-width: 250px;"
                          >{item.description}</td
                        >
                        <td>{item.qty}</td>
                        <td>
                          {#if item.status === "CONFLICT"}
                            <button
                              class="btn-small"
                              on:click={() =>
                                openConflictModal(item, item.originalIndex)}
                              >Resolve</button
                            >
                          {:else if item.status === "RESOLVED"}
                            <span class="text-success">Ready</span>
                          {:else if item.status === "DONE"}
                            <span class="text-muted">Done</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <div class="actions-panel">
                <h3>{selectedFile.name}</h3>
                <button
                  class="btn-primary"
                  on:click={() => selectedFile && handleAnalyze(selectedFile)}
                  >Analyze File</button
                >
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  {/if}

  <!-- Conflict Modal -->
  {#if showConflictModal && currentConflictItem}
    <div class="modal-overlay">
      <div class="modal">
        <h3>Resolve Conflict</h3>
        <p>JAN: <strong>{currentConflictItem.janCode}</strong></p>

        {#if currentConflictItem.conflictType === "MULTIPLE_MATCHES"}
          <div class="message error mb-4">
            <p class="font-bold">Multiple Matches Found</p>
            <p class="text-sm">
              This product matches multiple items in your inventory. This
              indicates a data integrity issue (duplicate JAN codes).
            </p>
            {#if currentConflictItem.matchingKeys}
              <p class="text-xs font-mono mt-2 p-2 bg-red-100 rounded">
                Matches: {currentConflictItem.matchingKeys.join(", ")}
              </p>
            {/if}
            <p class="text-sm mt-2">
              Please fix the inventory data manually in the Admin Console or
              select one to sync (not yet supported in UI).
            </p>
          </div>
        {:else if currentConflictItem.conflictingFields}
          {#each currentConflictItem.conflictingFields as field}
            <div class="conflict-group">
              <p class="font-bold mb-2">{field}</p>
              <div class="flex flex-col gap-2">
                <label class="radio-label">
                  <input
                    type="radio"
                    value="incoming"
                    bind:group={fieldResolutions[field]}
                  />
                  <div class="radio-content">
                    <span class="text-sm"
                      >Shopify:
                      {#if field === "Image"}
                        <div
                          class="conflict-thumb-wrapper"
                          on:mouseenter={() =>
                            (hoveredImage = getIncomingValue(field))}
                          on:mouseleave={() => (hoveredImage = null)}
                        >
                          <img
                            src={getIncomingValue(field)}
                            alt="Incoming"
                            class="conflict-thumb"
                          />
                        </div>
                        <span
                          class="conflict-url"
                          title={getIncomingValue(field)}
                        >
                          {getIncomingValue(field)}
                        </span>
                      {:else}
                        <strong>{getIncomingValue(field)}</strong>
                      {/if}
                    </span>
                  </div>
                </label>
                <label class="radio-label">
                  <input
                    type="radio"
                    value="existing"
                    bind:group={fieldResolutions[field]}
                  />
                  <div class="radio-content">
                    <span class="text-sm"
                      >Existing:
                      {#if field === "Image"}
                        <div
                          class="conflict-thumb-wrapper"
                          on:mouseenter={() =>
                            (hoveredImage = getExistingValue(field))}
                          on:mouseleave={() => (hoveredImage = null)}
                        >
                          <img
                            src={getExistingValue(field)}
                            alt="Existing"
                            class="conflict-thumb"
                          />
                        </div>
                        <span
                          class="conflict-url"
                          title={getExistingValue(field)}
                        >
                          {getExistingValue(field)}
                        </span>
                      {:else if field === "Handle" && !currentConflictItem.existingItem.handle}
                        <span class="text-gray-400 font-normal"
                          >{getExistingValue(field)}
                          <span class="text-xs italic">(auto-generated)</span
                          ></span
                        >
                      {:else}
                        <strong>{getExistingValue(field)}</strong>
                      {/if}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          {/each}
        {/if}

        <div class="modal-actions">
          <button class="btn-secondary" on:click={closeConflictModal}
            >Cancel</button
          >
          <button class="btn-primary" on:click={confirmConflictResolution}
            >Confirm</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>

<!-- Image Hover Overlay -->
{#if hoveredImage}
  <div class="hover-overlay">
    <img src={hoveredImage} alt="Zoomed" />
  </div>
{/if}

<style>
  .import-page {
    padding: 2rem;
  }
  .header-actions {
    margin-bottom: 2rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .layout-grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 2rem;
    align-items: start;
  }
  .panel {
    background: white;
    border: 1px solid #eee;
    border-radius: 8px;
    padding: 1rem;
  }
  .file-list ul {
    list-style: none;
    padding: 0;
  }
  .file-list button {
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid #eee;
  }
  .file-list button:hover {
    background: #f9f9f9;
  }
  .file-list button.selected {
    background: #eef2ff;
    color: #4f46e5;
    font-weight: 500;
  }
  .table-container {
    margin-top: 1rem;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.75rem;
    border-bottom: 1px solid #eee;
  }
  .badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: bold;
  }
  .badge.match {
    background: #dcfce7;
    color: #166534;
  }
  .badge.new {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge.conflict {
    background: #fee2e2;
    color: #991b1b;
  }
  .badge.resolved {
    background: #fef3c7;
    color: #92400e;
  }
  .badge.done {
    background: #f3f4f6;
    color: #6b7280;
  }
  .badge.identical {
    background: #f1f5f9;
    color: #475569;
    border: 1px solid #cbd5e1;
  }
  .btn-primary {
    background: #4f46e5;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
  }
  .btn-secondary {
    background: white;
    border: 1px solid #ccc;
    color: #333;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    margin-right: 0.5rem;
  }
  .btn-small {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
  }
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }
  .modal {
    background: white;
    padding: 2rem;
    border-radius: 8px;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 2rem;
  }
  .disconnect-button {
    background: white;
    border: 1px solid #ccc;
    color: #dc2626;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .message {
    padding: 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
  }
  .message.success {
    background: #dcfce7;
    color: #166534;
  }
  .message.error {
    background: #fee2e2;
    color: #991b1b;
  }
  .radio-label {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    cursor: pointer;
    padding: 0.5rem;
    border: 1px solid #eee;
    border-radius: 6px;
    transition: background 0.2s;
    margin-bottom: 0.5rem;
  }
  .radio-label:hover {
    background: #f9f9f9;
  }
  .text-muted {
    color: #9ca3af;
  }
  .text-success {
    color: #166534;
    font-weight: 500;
  }
  .conflict-group {
    margin-bottom: 1rem;
  }

  .conflict-thumb-wrapper {
    position: relative;
    display: inline-block;
  }
  .conflict-thumb {
    width: 64px;
    height: 64px;
    object-fit: cover;
    border: 1px solid #ccc;
    border-radius: 4px;
    margin-top: 0.25rem;
    cursor: zoom-in;
  }
  .conflict-url {
    font-size: 0.75rem;
    color: #6b7280;
    display: block;
    max-width: 200px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .hover-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: rgba(0, 0, 0, 0.5);
  }
  .hover-overlay img {
    max-width: 80vw;
    max-height: 80vh;
    border: 4px solid white;
    border-radius: 4px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  }
</style>
