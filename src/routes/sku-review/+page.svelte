<script lang="ts">
  import { onMount } from "svelte";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import type { Item } from "$lib/inventory";
  import {
    bulk_import_items,
    hide_exception,
    show_exception,
    update_field,
  } from "$lib/inventory";
  import { canonicalizeInventoryItemKey } from "$lib/sku";
  import { update_listing } from "$lib/listings-slice";
  import { generateHandle } from "$lib/handle-utils";
  import {
    isDriveConfigured,
    isAuthenticated,
    initiateOAuthFlow,
    handleOAuthCallback,
    listFilesInFolder,
    downloadFile,
    getStoredToken,
    clearToken,
    type DriveFile,
  } from "$lib/google-drive";
  import { goto } from "$app/navigation";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import { formatYen, formatEuro } from "$lib/formatters";
  import Papa from "papaparse";

  type IssueCode =
    | "DESCRIPTION"
    | "DESCRIPTION_CAPS"
    | "PRICE"
    | "COST"
    | "WEIGHT"
    | "IMAGE"
    | "HS_CODE"
    | "COUNTRY"
    | "UNLISTED"
    | "CATEGORY";

  interface ReviewIssue {
    code: IssueCode;
    label: string;
  }

  interface ReviewItem {
    key: string;
    item: Item;
    issues: ReviewIssue[];
  }

  interface IssueFilterDef {
    code: IssueCode | "ALL";
    label: string;
    tone: string;
  }

  type ImportValue = string | number;

  interface ImportConfig {
    issue: IssueCode;
    buttonLabel: string;
    valueLabel: string;
    valueColumnHints: string[];
    helpText: string;
    target: "inventory_field" | "listing_field" | "listing_body";
    field?: keyof Item | "productCategory";
    parseValue: (raw: string) => ImportValue | null;
  }

  interface CsvPreviewRow {
    janCode: string;
    rawValue: string;
    parsedValue: string;
    matchCount: number;
    status: "match" | "skip" | "invalid";
    reason: string;
  }

  interface ImportPreviewSummary {
    usableRows: number;
    matchingRows: number;
    matchingItems: number;
    skippedRows: number;
    invalidRows: number;
    duplicateJanRows: number;
    samples: CsvPreviewRow[];
    valueByJan: Map<string, ImportValue>;
  }

  const JAN_COLUMN_HINTS = [
    "jan code",
    "jan",
    "jan_code",
    "jancode",
    "bar-code no.",
    "barcode",
    "barcode no.",
  ];

  const normalizeHeaderKey = (key: string): string =>
    key
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .toLowerCase()
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const normalizeJanCode = (value: unknown): string => {
    let normalized = String(value ?? "")
      .normalize("NFKC")
      .replace(/\uFEFF/g, "")
      .trim()
      .replace(/\s+/g, "");
    if (/^\d+\.0+$/.test(normalized)) {
      normalized = normalized.replace(/\.0+$/, "");
    }
    return normalized;
  };

  const parseNumberish = (value: string): number | null => {
    const cleaned = value.replace(/[^0-9.-]/g, "");
    if (!cleaned) return null;
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const parseTrimmedString = (value: string): string | null => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  };

  const parseHsCode = (value: string): string | null => {
    const trimmed = value.replace(/\s+/g, "").trim();
    return trimmed ? trimmed : null;
  };

  const formatPreviewValue = (value: ImportValue | null): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };

  function autoSelectColumn(headers: string[], hints: string[]): string {
    const normalizedHints = hints.map(normalizeHeaderKey);
    for (const hint of normalizedHints) {
      const exact = headers.find(
        (header) => normalizeHeaderKey(header) === hint,
      );
      if (exact) return exact;
    }
    for (const hint of normalizedHints) {
      const partial = headers.find((header) =>
        normalizeHeaderKey(header).includes(hint),
      );
      if (partial) return partial;
    }
    return headers[0] || "";
  }

  const IMPORT_CONFIGS: Record<IssueCode, ImportConfig> = {
    DESCRIPTION: {
      issue: "DESCRIPTION",
      buttonLabel: "Import Descriptions",
      valueLabel: "Description",
      valueColumnHints: ["description", "title", "product name", "name"],
      helpText: "The selected value column will replace missing descriptions.",
      target: "inventory_field",
      field: "description",
      parseValue: parseTrimmedString,
    },
    DESCRIPTION_CAPS: {
      issue: "DESCRIPTION_CAPS",
      buttonLabel: "Import Descriptions",
      valueLabel: "Description",
      valueColumnHints: ["description", "title", "product name", "name"],
      helpText:
        "The selected value column will replace the ALL CAPS descriptions on the current filter.",
      target: "inventory_field",
      field: "description",
      parseValue: parseTrimmedString,
    },
    PRICE: {
      issue: "PRICE",
      buttonLabel: "Import Prices",
      valueLabel: "Price",
      valueColumnHints: [
        "price",
        "variant price",
        "selling price",
        "retail price",
      ],
      helpText:
        "The selected value column will be parsed as a numeric selling price.",
      target: "inventory_field",
      field: "price",
      parseValue: parseNumberish,
    },
    COST: {
      issue: "COST",
      buttonLabel: "Import Costs",
      valueLabel: "Cost",
      valueColumnHints: [
        "cost",
        "unit price (yen)",
        "supplier cost",
        "cost (yen)",
      ],
      helpText: "The selected value column will be parsed as a numeric cost.",
      target: "inventory_field",
      field: "cost",
      parseValue: parseNumberish,
    },
    WEIGHT: {
      issue: "WEIGHT",
      buttonLabel: "Import Weights",
      valueLabel: "Weight",
      valueColumnHints: ["weight", "grams", "variant grams", "weight in grams"],
      helpText: "The selected value column will be parsed as grams.",
      target: "inventory_field",
      field: "weight",
      parseValue: parseNumberish,
    },
    IMAGE: {
      issue: "IMAGE",
      buttonLabel: "Import Images",
      valueLabel: "Image URL",
      valueColumnHints: [
        "image",
        "image url",
        "photo",
        "photo url",
        "drive url",
      ],
      helpText:
        "The selected value column should contain the image URL to store on the item.",
      target: "inventory_field",
      field: "image",
      parseValue: parseTrimmedString,
    },
    HS_CODE: {
      issue: "HS_CODE",
      buttonLabel: "Import HS Codes",
      valueLabel: "HS Code",
      valueColumnHints: ["hs code", "hscode", "hs-code"],
      helpText: "Whitespace will be removed from imported HS codes.",
      target: "inventory_field",
      field: "hsCode",
      parseValue: parseHsCode,
    },
    COUNTRY: {
      issue: "COUNTRY",
      buttonLabel: "Import Country",
      valueLabel: "Country",
      valueColumnHints: ["country of origin", "country", "origin", "made in"],
      helpText: "The selected value column will set the country of origin.",
      target: "inventory_field",
      field: "countryOfOrigin",
      parseValue: parseTrimmedString,
    },
    UNLISTED: {
      issue: "UNLISTED",
      buttonLabel: "Import Listings",
      valueLabel: "Listing HTML",
      valueColumnHints: [
        "body html",
        "body (html)",
        "listing html",
        "html",
        "body",
      ],
      helpText:
        "The selected value column will become the listing body HTML. If a listing does not exist yet, one will be created for the matching SKU.",
      target: "listing_body",
      parseValue: parseTrimmedString,
    },
    CATEGORY: {
      issue: "CATEGORY",
      buttonLabel: "Import Categories",
      valueLabel: "Category",
      valueColumnHints: ["product category", "category"],
      helpText: "The selected value column will populate the listing category.",
      target: "listing_field",
      field: "productCategory",
      parseValue: parseTrimmedString,
    },
  };

  const ISSUE_FILTERS: IssueFilterDef[] = [
    { code: "ALL", label: "All", tone: "all" },
    { code: "UNLISTED", label: "Unlisted", tone: "unlisted" },
    { code: "IMAGE", label: "Image", tone: "image" },
    { code: "DESCRIPTION", label: "Description", tone: "description" },
    { code: "DESCRIPTION_CAPS", label: "ALL CAPS", tone: "description-caps" },
    { code: "PRICE", label: "Price", tone: "price" },
    { code: "COST", label: "Cost", tone: "cost" },
    { code: "WEIGHT", label: "Weight", tone: "weight" },
    { code: "HS_CODE", label: "HS Code", tone: "hs-code" },
    { code: "COUNTRY", label: "Country", tone: "country" },
    { code: "CATEGORY", label: "Category", tone: "category" },
  ];

  function issue(code: IssueCode, label: string): ReviewIssue {
    return { code, label };
  }

  function getFilterLabel(code: IssueCode | "ALL"): string {
    return ISSUE_FILTERS.find((filter) => filter.code === code)?.label || "All";
  }

  function getFilterCount(code: IssueCode | "ALL"): number {
    return code === "ALL" ? baseVisibleItems.length : (issueCounts[code] ?? 0);
  }

  let skipOutOfStock = true;
  let showHidden = false;
  let activeIssueFilter: IssueCode | "ALL" = "ALL";
  let reviewItems: ReviewItem[] = [];
  let issueCounts: Partial<Record<IssueCode, number>> = {};
  let skippedCount = 0;
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let importOpen = false;
  let importLoading = false;
  let importApplying = false;
  let importError = "";
  let importSuccess = "";
  let selectedDriveFileId = "";
  let selectedDriveFile: DriveFile | null = null;
  let csvHeaders: string[] = [];
  let csvRows: Array<Record<string, unknown>> = [];
  let janColumn = "";
  let valueColumn = "";
  let previousImportIssue: IssueCode | "ALL" = "ALL";

  onMount(async () => {
    driveConfigured = isDriveConfigured();
    if (!driveConfigured) return;

    const callbackResult = await handleOAuthCallback();
    if (callbackResult) {
      authenticated = true;
      if (
        callbackResult.returnUrl &&
        callbackResult.returnUrl !== window.location.pathname
      ) {
        goto(callbackResult.returnUrl, { replaceState: true });
        return;
      }
      await loadDriveFiles();
    } else {
      authenticated = isAuthenticated();
      if (authenticated) await loadDriveFiles();
    }
  });

  async function loadDriveFiles() {
    const token = getStoredToken();
    if (!token) {
      authenticated = false;
      return;
    }

    loadingFiles = true;
    importError = "";

    try {
      driveFiles = await listFilesInFolder(token.access_token);
      driveFiles = driveFiles.filter(
        (file) => file.mimeType === "text/csv" || file.name.endsWith(".csv"),
      );
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      importError = `Failed to load Drive files: ${errorMessage}`;
      if (
        errorMessage.toLowerCase().includes("401") ||
        errorMessage.toLowerCase().includes("unauthorized")
      ) {
        clearToken();
        authenticated = false;
      }
    } finally {
      loadingFiles = false;
    }
  }

  function handleConnectDrive() {
    initiateOAuthFlow(window.location.href);
  }

  function handleDisconnectDrive() {
    clearToken();
    authenticated = false;
    driveFiles = [];
    resetImportSelection();
  }

  function toggleImportPanel() {
    importOpen = !importOpen;
    importError = "";
    importSuccess = "";

    if (
      importOpen &&
      authenticated &&
      driveFiles.length === 0 &&
      !loadingFiles
    ) {
      void loadDriveFiles();
    }
  }

  function resetImportSelection() {
    selectedDriveFileId = "";
    selectedDriveFile = null;
    csvHeaders = [];
    csvRows = [];
    janColumn = "";
    valueColumn = "";
  }

  async function handleDriveFileSelection(fileId: string) {
    selectedDriveFile = driveFiles.find((file) => file.id === fileId) || null;
    selectedDriveFileId = fileId;
    csvHeaders = [];
    csvRows = [];
    janColumn = "";
    valueColumn = "";
    importError = "";
    importSuccess = "";

    if (!selectedDriveFile) return;

    const token = getStoredToken();
    if (!token) {
      authenticated = false;
      importError = "Reconnect Google Drive to load this CSV.";
      return;
    }

    importLoading = true;

    try {
      const content = await downloadFile(
        selectedDriveFile.id,
        token.access_token,
      );
      const parsed = Papa.parse<Record<string, unknown>>(content, {
        header: true,
        skipEmptyLines: "greedy",
      });
      csvHeaders = parsed.meta.fields || [];
      csvRows = parsed.data.filter((row) =>
        Object.values(row || {}).some((value) => String(value ?? "").trim()),
      );
      janColumn = autoSelectColumn(csvHeaders, JAN_COLUMN_HINTS);
      valueColumn = autoSelectColumn(
        csvHeaders,
        activeImportConfig?.valueColumnHints || [],
      );
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
    } finally {
      importLoading = false;
    }
  }

  function handleDriveFileChange(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    void handleDriveFileSelection(target.value);
  }

  function buildImportPreview(
    rows: Array<Record<string, unknown>>,
    selectedJanColumn: string,
    selectedValueColumn: string,
    config: ImportConfig | null,
    itemsByJan: Map<string, ReviewItem[]>,
  ): ImportPreviewSummary {
    if (!config || !selectedJanColumn || !selectedValueColumn) {
      return {
        usableRows: 0,
        matchingRows: 0,
        matchingItems: 0,
        skippedRows: 0,
        invalidRows: 0,
        duplicateJanRows: 0,
        samples: [],
        valueByJan: new Map(),
      };
    }

    const samples: CsvPreviewRow[] = [];
    const valueByJan = new Map<string, ImportValue>();
    const matchedJans = new Set<string>();
    const duplicateSeen = new Set<string>();
    let usableRows = 0;
    let matchingRows = 0;
    let matchingItems = 0;
    let skippedRows = 0;
    let invalidRows = 0;
    let duplicateJanRows = 0;

    for (const row of rows) {
      const janCode = normalizeJanCode(row[selectedJanColumn]);
      const rawValue = String(row[selectedValueColumn] ?? "").trim();
      const parsedValue = config.parseValue(rawValue);
      let status: CsvPreviewRow["status"] = "invalid";
      let reason = "Missing JAN";
      let matchCount = 0;

      if (!janCode) {
        invalidRows += 1;
      } else if (parsedValue === null) {
        status = "invalid";
        reason = `Missing ${config.valueLabel}`;
        invalidRows += 1;
      } else {
        usableRows += 1;
        const matchingReviewItems = itemsByJan.get(janCode) || [];
        matchCount = matchingReviewItems.length;
        if (matchingReviewItems.length > 0) {
          status = "match";
          reason =
            matchingReviewItems.length === 1
              ? "1 matching exception row"
              : `${matchingReviewItems.length} matching exception rows`;
          matchingRows += 1;
          if (!matchedJans.has(janCode)) {
            matchedJans.add(janCode);
            matchingItems += matchingReviewItems.length;
          } else {
            duplicateJanRows += 1;
            duplicateSeen.add(janCode);
          }
          valueByJan.set(janCode, parsedValue);
        } else {
          status = "skip";
          reason = "JAN is not in the current exception set";
          skippedRows += 1;
        }
      }

      if (samples.length < 8) {
        samples.push({
          janCode: janCode || "—",
          rawValue,
          parsedValue: formatPreviewValue(parsedValue),
          matchCount,
          status,
          reason,
        });
      }
    }

    if (duplicateSeen.size > 0) {
      samples.unshift({
        janCode: "—",
        rawValue: "—",
        parsedValue: "—",
        matchCount: 0,
        status: "skip",
        reason: `${duplicateSeen.size} JAN codes appear more than once. The last matching CSV row wins.`,
      });
      samples.splice(8);
    }

    return {
      usableRows,
      matchingRows,
      matchingItems,
      skippedRows,
      invalidRows,
      duplicateJanRows,
      samples,
      valueByJan,
    };
  }

  function applyImportValue(
    uid: string,
    reviewItem: ReviewItem,
    config: ImportConfig,
    value: ImportValue,
    timestamp: number,
  ): boolean {
    const { key, item } = reviewItem;

    if (config.target === "inventory_field" && config.field) {
      const field = config.field as keyof Item;
      const currentValue = (item as any)[field] ?? "";
      if (String(currentValue) === String(value)) return false;
      broadcast(
        firestore,
        uid,
        update_field({
          id: key,
          field,
          from: currentValue as string | number,
          to: value as string | number,
        }),
      );
      return true;
    }

    if (
      config.target === "listing_field" &&
      config.field === "productCategory"
    ) {
      const handle = $store.listings.idToHandle[key];
      if (!handle) return false;
      const listing = $store.listings.handleToListing[handle];
      if (!listing) return false;
      const nextCategory = String(value);
      if ((listing.productCategory || "") === nextCategory) return false;
      broadcast(
        firestore,
        uid,
        update_listing({ handle, changes: { productCategory: nextCategory } }),
      );
      return true;
    }

    if (config.target === "listing_body") {
      const handle =
        $store.listings.idToHandle[key] ||
        generateHandle(item.description || "Untitled", item.janCode);
      const listing = $store.listings.handleToListing[handle];
      const bodyHtml = String(value);

      if (listing) {
        if ((listing.bodyHtml || "") === bodyHtml) return false;
        broadcast(
          firestore,
          uid,
          update_listing({ handle, changes: { bodyHtml } }),
        );
        return true;
      }

      broadcast(
        firestore,
        uid,
        bulk_import_items({
          items: [
            {
              type: "update",
              id: key,
              item: {
                ...item,
                qty: 0,
                shipped: 0,
                handle,
                bodyHtml,
                timestamp,
              } as any,
            },
          ],
        }),
      );
      return true;
    }

    return false;
  }

  async function confirmImportSelection() {
    if (!$user?.uid || !activeImportConfig) return;
    if (!importPreview.matchingItems) {
      importError = "No matching rows in the current exception set.";
      return;
    }

    importApplying = true;
    importError = "";
    importSuccess = "";

    try {
      let updatedRows = 0;
      let skippedRows = 0;
      const timestamp = Date.now();

      for (const reviewItem of currentImportItems) {
        const mappedValue = importPreview.valueByJan.get(
          normalizeJanCode(reviewItem.item.janCode),
        );
        if (mappedValue === undefined) {
          skippedRows += 1;
          continue;
        }
        if (
          applyImportValue(
            $user.uid,
            reviewItem,
            activeImportConfig,
            mappedValue,
            timestamp,
          )
        ) {
          updatedRows += 1;
        } else {
          skippedRows += 1;
        }
      }

      importSuccess = `Applied ${activeImportConfig.valueLabel.toLowerCase()} to ${updatedRows} item${updatedRows === 1 ? "" : "s"}; skipped ${skippedRows} current rows without a usable change.`;
    } catch (e) {
      importError = e instanceof Error ? e.message : String(e);
    } finally {
      importApplying = false;
    }
  }

  function toggleHide(key: string) {
    if (!$user || !$user.uid) return;
    const isHidden = $store.inventory.hiddenExceptions?.[key];
    if (isHidden) {
      broadcast(
        firestore,
        $user.uid,
        show_exception({ itemKey: canonicalizeInventoryItemKey(key) }),
      );
    } else {
      broadcast(
        firestore,
        $user.uid,
        hide_exception({ itemKey: canonicalizeInventoryItemKey(key) }),
      );
    }
  }

  $: {
    const inv = $store.inventory.idToItem;
    const listings = $store.listings;
    reviewItems = [];
    skippedCount = 0;
    if (inv) {
      for (const key in inv) {
        const item = inv[key];
        const issues: ReviewIssue[] = [];

        if (!item.description) {
          issues.push(issue("DESCRIPTION", "Description"));
        } else if (
          item.description.length > 0 &&
          item.description === item.description.toUpperCase() &&
          /[a-z]/i.test(item.description)
        ) {
          issues.push(issue("DESCRIPTION_CAPS", "Description (ALL CAPS)"));
        }

        if (!item.price) issues.push(issue("PRICE", "Price"));
        if (!item.cost) issues.push(issue("COST", "Cost"));
        if (!item.weight) issues.push(issue("WEIGHT", "Weight"));
        if (!item.image) issues.push(issue("IMAGE", "Image"));
        if (!item.hsCode) issues.push(issue("HS_CODE", "HS Code"));
        if (!item.countryOfOrigin) {
          issues.push(issue("COUNTRY", "Country of Origin"));
        }

        const idToHandle = $store.listings.idToHandle;
        const handleToListing = $store.listings.handleToListing;
        const handle = idToHandle[key];

        const listing = handle ? handleToListing[handle] : undefined;
        if (!listing || !listing.bodyHtml) {
          issues.push(issue("UNLISTED", "Unlisted"));
        }
        if (listing && !listing.productCategory) {
          issues.push(issue("CATEGORY", "Category"));
        }

        const stock = (item.qty || 0) - (item.shipped || 0);

        if (stock <= 0) {
          skippedCount++;
          if (skipOutOfStock) continue;
        }

        if (issues.length > 0) {
          reviewItems.push({ key, item, issues });
        }
      }
      reviewItems.sort((a, b) =>
        b.item.creationDate.localeCompare(a.item.creationDate),
      );
    }
  }

  $: hiddenExceptions = $store.inventory.hiddenExceptions || {};
  $: baseVisibleItems = reviewItems.filter(
    (i) => showHidden || !hiddenExceptions[i.key],
  );
  $: hiddenCount = reviewItems.length - baseVisibleItems.length;
  $: issueCounts = ISSUE_FILTERS.reduce(
    (acc, filter) => {
      if (filter.code === "ALL") return acc;
      acc[filter.code] = baseVisibleItems.filter((item) =>
        item.issues.some((entry) => entry.code === filter.code),
      ).length;
      return acc;
    },
    {} as Partial<Record<IssueCode, number>>,
  );
  $: availableFilters = ISSUE_FILTERS.filter(
    (filter) =>
      filter.code === "ALL" || (issueCounts[filter.code as IssueCode] || 0) > 0,
  );
  $: if (
    activeIssueFilter !== "ALL" &&
    (issueCounts[activeIssueFilter as IssueCode] || 0) === 0
  ) {
    activeIssueFilter = "ALL";
  }
  $: visibleItems =
    activeIssueFilter === "ALL"
      ? baseVisibleItems
      : baseVisibleItems.filter((item) =>
          item.issues.some((entry) => entry.code === activeIssueFilter),
        );
  $: activeImportConfig =
    activeIssueFilter === "ALL" ? null : IMPORT_CONFIGS[activeIssueFilter];
  $: currentImportItems = activeIssueFilter === "ALL" ? [] : visibleItems;
  $: currentImportItemsByJan = currentImportItems.reduce((acc, reviewItem) => {
    const janCode = normalizeJanCode(reviewItem.item.janCode);
    if (!janCode) return acc;
    const existing = acc.get(janCode) || [];
    existing.push(reviewItem);
    acc.set(janCode, existing);
    return acc;
  }, new Map<string, ReviewItem[]>());
  $: importPreview = buildImportPreview(
    csvRows,
    janColumn,
    valueColumn,
    activeImportConfig,
    currentImportItemsByJan,
  );
  $: if (activeIssueFilter !== previousImportIssue) {
    previousImportIssue = activeIssueFilter;
    importError = "";
    importSuccess = "";
    if (activeIssueFilter === "ALL") {
      importOpen = false;
    } else if (csvHeaders.length > 0) {
      valueColumn = autoSelectColumn(
        csvHeaders,
        activeImportConfig?.valueColumnHints || [],
      );
      if (!janColumn)
        janColumn = autoSelectColumn(csvHeaders, JAN_COLUMN_HINTS);
    }
  }
</script>

<div class="container">
  <h1>SKU Review</h1>
  <div class="header-controls">
    <h2 class="summary">
      {visibleItems.length}
      {#if activeIssueFilter === "ALL"}
        exceptions found.
      {:else}
        {getFilterLabel(activeIssueFilter)}
        exceptions found.
      {/if}
    </h2>
    {#if hiddenCount > 0}
      <span class="hidden-count">({hiddenCount} hidden)</span>
    {/if}
  </div>
  <p>Items missing required data or with invalid formatting.</p>

  <div class="filters">
    <label>
      <input type="checkbox" bind:checked={skipOutOfStock} />
      {#if skipOutOfStock}
        Skip out of stock ({skippedCount} skipped)
      {:else}
        Skip out of stock ({skippedCount} would be skipped)
      {/if}
    </label>

    <label>
      <input type="checkbox" bind:checked={showHidden} />
      Show hidden items
    </label>
  </div>

  <div class="summary-dashboard">
    {#each availableFilters as filter}
      <button
        class="summary-card {filter.tone}"
        class:active={activeIssueFilter === filter.code}
        on:click={() => (activeIssueFilter = filter.code)}
      >
        <span class="label">{filter.label}</span>
        <span class="value">{getFilterCount(filter.code)}</span>
      </button>
    {/each}
  </div>

  {#if activeImportConfig}
    <div class="import-toolbar">
      <button class="import-trigger" on:click={toggleImportPanel}>
        {activeImportConfig.buttonLabel}
      </button>
      {#if currentImportItems.length > 0}
        <span class="import-scope">
          Applies only to the {currentImportItems.length} currently filtered
          {currentImportItems.length === 1 ? " row" : " rows"}.
        </span>
      {/if}
    </div>

    {#if importOpen}
      <div class="import-panel">
        <h3>{activeImportConfig.buttonLabel}</h3>
        <p>{activeImportConfig.helpText}</p>

        {#if !driveConfigured}
          <div class="import-message error">
            Google Drive is not configured in this environment.
          </div>
        {:else if !authenticated}
          <div class="import-auth">
            <p>Connect Google Drive to choose a CSV for this import.</p>
            <button class="import-trigger" on:click={handleConnectDrive}>
              Connect Google Drive
            </button>
          </div>
        {:else}
          <div class="import-file-controls">
            <label>
              Drive CSV
              <select
                bind:value={selectedDriveFileId}
                on:change={handleDriveFileChange}
              >
                <option value="">Select a CSV…</option>
                {#each driveFiles as file}
                  <option value={file.id}>{file.name}</option>
                {/each}
              </select>
            </label>

            <div class="import-file-actions">
              <button class="btn-small" on:click={() => void loadDriveFiles()}>
                Refresh files
              </button>
              <button class="btn-small" on:click={handleDisconnectDrive}>
                Disconnect Drive
              </button>
            </div>
          </div>

          {#if loadingFiles}
            <div class="import-message">Loading Drive files…</div>
          {/if}

          {#if importLoading}
            <div class="import-message">Loading CSV preview…</div>
          {/if}

          {#if selectedDriveFile && csvHeaders.length > 0}
            <div class="import-mapping">
              <label>
                JAN column
                <select bind:value={janColumn}>
                  {#each csvHeaders as header}
                    <option value={header}>{header}</option>
                  {/each}
                </select>
              </label>

              <label>
                {activeImportConfig.valueLabel} column
                <select bind:value={valueColumn}>
                  {#each csvHeaders as header}
                    <option value={header}>{header}</option>
                  {/each}
                </select>
              </label>
            </div>

            {#if janColumn && valueColumn}
              <div class="import-summary">
                <div class="import-summary-line">
                  Treating <strong>{janColumn}</strong> as JAN and
                  <strong>{valueColumn}</strong> as {activeImportConfig.valueLabel}.
                </div>
                <div class="import-stats">
                  <span>{importPreview.usableRows} usable CSV rows</span>
                  <span>{importPreview.matchingRows} matching CSV rows</span>
                  <span
                    >{importPreview.matchingItems} matching exception rows</span
                  >
                  <span>{importPreview.skippedRows} skipped CSV rows</span>
                  {#if importPreview.invalidRows > 0}
                    <span>{importPreview.invalidRows} invalid CSV rows</span>
                  {/if}
                  {#if importPreview.duplicateJanRows > 0}
                    <span
                      >{importPreview.duplicateJanRows} duplicate JAN rows</span
                    >
                  {/if}
                </div>
              </div>

              {#if importPreview.samples.length > 0}
                <div class="import-preview">
                  <h4>Sample rows</h4>
                  <table class="preview-table">
                    <thead>
                      <tr>
                        <th>JAN</th>
                        <th>{activeImportConfig.valueLabel}</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each importPreview.samples as sample}
                        <tr class={`preview-${sample.status}`}>
                          <td>{sample.janCode}</td>
                          <td>{sample.parsedValue || sample.rawValue || "—"}</td
                          >
                          <td>{sample.reason}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}

              <div class="import-actions">
                <button
                  class="import-trigger"
                  disabled={importApplying || importPreview.matchingItems === 0}
                  on:click={() => void confirmImportSelection()}
                >
                  {#if importApplying}
                    Applying…
                  {:else}
                    Apply to {importPreview.matchingItems} matching
                    {importPreview.matchingItems === 1 ? " row" : " rows"}
                  {/if}
                </button>
              </div>
            {/if}
          {/if}
        {/if}

        {#if importError}
          <div class="import-message error">{importError}</div>
        {/if}

        {#if importSuccess}
          <div class="import-message success">{importSuccess}</div>
        {/if}
      </div>
    {/if}
  {/if}

  {#if visibleItems.length === 0}
    <div class="empty">All set! No items missing data (that are visible).</div>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Image</th>
          <th>JAN</th>
          <th>Subtype</th>
          <th>Price</th>
          <th>Cost</th>
          <th>Description</th>
          <th>Stock</th>
          <th>Missing</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        {#each visibleItems as { key, item, issues } (key)}
          <tr class:hidden-row={hiddenExceptions[key]}>
            <td>
              {#if item.image}
                <div class="thumb-wrap">
                  <ImageThumbnail src={item.image} alt="Product" />
                </div>
              {:else}
                <span class="no-img">No Img</span>
              {/if}
            </td>
            <td>{item.janCode}</td>
            <td>{item.subtype}</td>
            <td>{formatEuro(item.price)}</td>
            <td>{formatYen(item.cost)}</td>
            <td class="desc">{item.description}</td>
            <td>{(item.qty || 0) - (item.shipped || 0)}</td>
            <td>
              {#each issues as entry}
                <span class="badge">{entry.label}</span>
              {/each}
            </td>
            <td>
              <button class="btn-small" on:click={() => toggleHide(key)}>
                {hiddenExceptions[key] ? "Unhide" : "Hide"}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .container {
    padding: 2rem;
  }
  .header-controls {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  .summary {
    font-size: 1.25rem;
    color: #b91c1c;
    margin: 0;
  }
  .hidden-count {
    font-size: 0.9rem;
    color: #6b7280;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }
  .summary-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 0.6rem;
    margin-bottom: 1.5rem;
  }
  .import-toolbar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .import-trigger {
    padding: 0.55rem 0.9rem;
    border: 1px solid #111827;
    border-radius: 8px;
    background: #111827;
    color: white;
    font-weight: 700;
    cursor: pointer;
  }
  .import-trigger:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .import-scope {
    color: #4b5563;
    font-size: 0.95rem;
  }
  .import-panel {
    border: 1px solid #d1d5db;
    border-radius: 12px;
    background: #f9fafb;
    padding: 1rem;
    margin-bottom: 1.5rem;
  }
  .import-panel h3 {
    margin: 0 0 0.35rem 0;
  }
  .import-panel p {
    margin-top: 0;
    color: #4b5563;
  }
  .import-file-controls,
  .import-mapping,
  .import-actions,
  .import-auth {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    align-items: end;
    margin-top: 1rem;
  }
  .import-file-controls label,
  .import-mapping label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-weight: 600;
    min-width: 220px;
  }
  .import-file-controls select,
  .import-mapping select {
    padding: 0.5rem 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 8px;
    background: white;
  }
  .import-file-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .import-summary {
    margin-top: 1rem;
    padding: 0.75rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
  }
  .import-summary-line {
    margin-bottom: 0.5rem;
  }
  .import-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 0.9rem;
    color: #374151;
    font-size: 0.9rem;
  }
  .import-preview {
    margin-top: 1rem;
  }
  .import-preview h4 {
    margin: 0 0 0.5rem 0;
  }
  .preview-table {
    width: 100%;
    border-collapse: collapse;
    background: white;
  }
  .preview-table th,
  .preview-table td {
    border: 1px solid #e5e7eb;
    padding: 0.45rem 0.55rem;
    vertical-align: top;
  }
  .preview-match {
    background: #ecfdf5;
  }
  .preview-skip {
    background: #fff7ed;
  }
  .preview-invalid {
    background: #fef2f2;
  }
  .import-message {
    margin-top: 1rem;
    padding: 0.7rem 0.8rem;
    border-radius: 8px;
  }
  .import-message.error {
    background: #fef2f2;
    color: #991b1b;
  }
  .import-message.success {
    background: #ecfdf5;
    color: #166534;
  }
  .summary-card {
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    background: #fff;
    padding: 0.55rem 0.65rem;
    text-align: left;
    cursor: pointer;
    transition:
      background 0.15s ease,
      border-color 0.15s ease,
      transform 0.08s ease;
  }
  .summary-card:hover {
    transform: translateY(-1px);
  }
  .summary-card .label {
    display: block;
    font-size: 0.75rem;
    color: #4b5563;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .summary-card .value {
    display: block;
    font-size: 1.2rem;
    font-weight: 800;
    line-height: 1.1;
    margin-top: 0.12rem;
  }
  .summary-card.active {
    box-shadow: inset 0 0 0 2px #111827;
  }
  .summary-card.all {
    background: #f3f4f6;
    color: #111827;
  }
  .summary-card.unlisted {
    background: #fee2e2;
    color: #991b1b;
  }
  .summary-card.image {
    background: #ede9fe;
    color: #5b21b6;
  }
  .summary-card.description {
    background: #e0f2fe;
    color: #075985;
  }
  .summary-card.description-caps {
    background: #fff7ed;
    color: #9a3412;
  }
  .summary-card.price {
    background: #dcfce7;
    color: #166534;
  }
  .summary-card.cost {
    background: #fef3c7;
    color: #92400e;
  }
  .summary-card.weight {
    background: #dbeafe;
    color: #1d4ed8;
  }
  .summary-card.hs-code {
    background: #fae8ff;
    color: #a21caf;
  }
  .summary-card.country {
    background: #ecfccb;
    color: #3f6212;
  }
  .summary-card.category {
    background: #fce7f3;
    color: #9d174d;
  }
  .btn-small {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    background: white;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
  }
  .btn-small:hover {
    background: #f9fafb;
  }
  .hidden-row {
    opacity: 0.5;
    background: #f9fafb;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 1rem;
  }
  th,
  td {
    border: 1px solid #eee;
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  .thumb-wrap {
    width: 50px;
    height: 50px;
    overflow: hidden;
  }
  :global(.thumb) {
    width: 50px;
    height: 50px;
    object-fit: cover;
  }
  .no-img {
    display: inline-block;
    width: 50px;
    height: 50px;
    background: #f3f4f6;
    color: #9ca3af;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
  }
  .badge {
    background: #fee2e2;
    color: #991b1b;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
    margin-right: 4px;
    display: inline-block;
    margin-bottom: 2px;
  }
  .empty {
    margin-top: 2rem;
    color: #166534;
    font-weight: bold;
  }
  @media (max-width: 720px) {
    .container {
      padding: 1rem;
    }
    .summary-dashboard {
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    }
    .import-file-controls label,
    .import-mapping label {
      min-width: 100%;
    }
  }
</style>
