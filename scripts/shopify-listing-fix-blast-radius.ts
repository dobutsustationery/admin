import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { performance } from "perf_hooks";
import { rootReducer } from "../src/lib/root-reducer";
import {
  diffLocalListingAgainstShopifyCatalogDetailed,
  type DetailedShopifyDiffResult,
  type VariantDiffDetail,
  type VariantDiffField,
} from "../src/lib/shopify-deep-diff";

type JsonObject = Record<string, any>;
type RowStatus = "admin_only" | "shopify_only" | "both";
type IssueKey =
  | "presence"
  | "bare_sku"
  | "quantity"
  | "variant_image"
  | "gallery"
  | "status"
  | "category"
  | "price"
  | "weight"
  | "variant_structure"
  | "variant_identity"
  | "single_jan_subtype"
  | "metadata"
  | "synced";

interface BackupDoc {
  id: string;
  data: JsonObject;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx < 0 ? undefined : args[idx + 1];
}

function resolveBackupPath(input: string): string {
  const p = resolve(input);
  if (!existsSync(p)) throw new Error(`Backup path does not exist: ${p}`);
  if (statSync(p).isDirectory()) return join(p, "firestore-export.json");
  return p;
}

function timestampKey(action: any): bigint {
  const ts = action?.timestamp;
  if (typeof ts?._seconds === "number") {
    return (
      BigInt(ts._seconds) * 1_000_000_000n +
      BigInt(Number(ts._nanoseconds) || 0)
    );
  }
  if (typeof ts?.seconds === "number") {
    return (
      BigInt(ts.seconds) * 1_000_000_000n + BigInt(Number(ts.nanoseconds) || 0)
    );
  }
  if (typeof action?._timestamp_millis === "number") {
    return BigInt(action._timestamp_millis) * 1_000_000n;
  }
  if (typeof action?._timestamp === "number") {
    return BigInt(action._timestamp) * 1_000_000n;
  }
  return 0n;
}

function loadActions(backupPath: string): JsonObject[] {
  const backup = JSON.parse(readFileSync(backupPath, "utf-8"));
  const docs = (backup?.collections?.broadcast?.documents || []) as BackupDoc[];
  return docs
    .map((doc) => ({ id: doc.id, ...doc.data }))
    .sort((a, b) => {
      const diff = timestampKey(a) - timestampKey(b);
      if (diff < 0n) return -1;
      if (diff > 0n) return 1;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
}

function normalizeHandle(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isLocallyValidListing(state: any, handle: string): boolean {
  const listing = state.listings?.handleToListing?.[handle];
  if (!listing) return false;

  const title = String(listing.title || "").trim();
  const hasDescription = !!title && title.toLowerCase() !== "untitled";

  const category = String(listing.productCategory || "").trim();
  const knownCategories = Array.isArray(state.listings?.knownCategories)
    ? state.listings.knownCategories
    : [];
  const hasValidCategory = !!category && knownCategories.includes(category);

  const idToHandle = state.listings?.idToHandle || {};
  const idToItem = state.inventory?.idToItem || {};
  const hasValidPrice = Object.entries(idToHandle).some(([id, h]) => {
    if (String(h || "").trim() !== handle) return false;
    return Number(idToItem[id]?.price || 0) > 0;
  });

  return hasDescription && hasValidCategory && hasValidPrice;
}

function getAdminHandles(state: any): string[] {
  const unique = new Map<string, string>();
  Object.keys(state.listings?.handleToListing || {}).forEach((raw) => {
    const normalized = normalizeHandle(raw);
    if (!normalized) return;
    if (!isLocallyValidListing(state, raw)) return;
    if (!unique.has(normalized)) unique.set(normalized, String(raw).trim());
  });
  return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
}

function getRemoteHandles(state: any): string[] {
  const unique = new Map<string, string>();
  Object.keys(state.shopifyCatalog?.handleToListing || {}).forEach((raw) => {
    const normalized = normalizeHandle(raw);
    if (!normalized) return;
    if (!unique.has(normalized)) unique.set(normalized, String(raw).trim());
  });
  return Array.from(unique.values()).sort((a, b) => a.localeCompare(b));
}

function variantHasField(
  detail: VariantDiffDetail,
  field: VariantDiffField,
): boolean {
  return detail.fields.includes(field);
}

function isBareShopifySku(detail: VariantDiffDetail): boolean {
  const localSku = String(detail.local?.sku || "").trim();
  const localJan = String(detail.local?.janCode || "").trim();
  const remoteSku = String(detail.remote?.sku || "").trim();
  return (
    variantHasField(detail, "sku") &&
    !!localSku &&
    !!remoteSku &&
    /^\d+$/.test(remoteSku) &&
    (remoteSku === localJan || localSku.startsWith(remoteSku)) &&
    localSku !== remoteSku
  );
}

function classifyIssueKeys(
  status: RowStatus,
  diffDetails: DetailedShopifyDiffResult | null,
): IssueKey[] {
  if (status !== "both") return ["presence"];
  if (!diffDetails || diffDetails.matches) return ["synced"];

  const keys = new Set<IssueKey>();
  const fieldKeys = new Set(diffDetails.fieldDiffs.map((diff) => diff.key));
  const variantDiffs = diffDetails.variantDiffs || [];

  if (
    variantDiffs.some(
      (diff) => diff.matchType !== "singleJan" && isBareShopifySku(diff),
    )
  ) {
    keys.add("bare_sku");
  }
  if (variantDiffs.some((diff) => variantHasField(diff, "inventoryQuantity"))) {
    keys.add("quantity");
  }
  if (variantDiffs.some((diff) => variantHasField(diff, "image"))) {
    keys.add("variant_image");
  }
  if (diffDetails.galleryImageDiffs.length > 0) keys.add("gallery");
  if (fieldKeys.has("status")) keys.add("status");
  if (fieldKeys.has("productCategory") || fieldKeys.has("productType")) {
    keys.add("category");
  }
  if (variantDiffs.some((diff) => variantHasField(diff, "price"))) {
    keys.add("price");
  }
  if (variantDiffs.some((diff) => variantHasField(diff, "weight"))) {
    keys.add("weight");
  }
  if (
    variantDiffs.some(
      (diff) =>
        diff.matchType === "missingLocal" || diff.matchType === "missingRemote",
    )
  ) {
    keys.add("variant_structure");
  }
  if (
    variantDiffs.some(
      (diff) =>
        diff.matchType !== "singleJan" &&
        (variantHasField(diff, "subtype") ||
          variantHasField(diff, "janCode") ||
          (variantHasField(diff, "sku") && !isBareShopifySku(diff))),
    )
  ) {
    keys.add("variant_identity");
  }
  if (variantDiffs.some((diff) => diff.matchType === "singleJan")) {
    keys.add("single_jan_subtype");
  }
  if (
    ["handle", "title", "bodyHtml", "option1Name"].some((key) =>
      fieldKeys.has(key as any),
    )
  ) {
    keys.add("metadata");
  }

  return keys.size ? Array.from(keys).sort() : ["metadata"];
}

function inventoryKeySummary(state: any) {
  const idToItem = state.inventory?.idToItem || {};
  let subtypedItems = 0;
  let listedItems = 0;
  const keyedWithSubtype: any[] = [];
  for (const [key, item] of Object.entries(idToItem)) {
    const it = item as any;
    if (String(it.subtype || "").trim()) {
      subtypedItems++;
      keyedWithSubtype.push({
        key,
        janCode: it.janCode || "",
        subtype: it.subtype || "",
        handle: it.handle || "",
        qty: Number(it.qty || 0),
        shipped: Number(it.shipped || 0),
        description: it.description || "",
      });
    }
    if (String(it.handle || "").trim()) listedItems++;
  }
  keyedWithSubtype.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    inventoryItems: Object.keys(idToItem).length,
    subtypedItems,
    listedItems,
    keyedWithSubtype,
  };
}

function shopifySummary(state: any) {
  const adminHandles = getAdminHandles(state);
  const remoteHandles = getRemoteHandles(state);
  const allHandles = Array.from(
    new Set([...adminHandles, ...remoteHandles].map(normalizeHandle)),
  ).sort((a, b) => a.localeCompare(b));
  const adminByNormalized = new Map(
    adminHandles.map((handle) => [normalizeHandle(handle), handle]),
  );
  const remoteByNormalized = new Map(
    remoteHandles.map((handle) => [normalizeHandle(handle), handle]),
  );

  const issueCounts: Record<string, number> = {};
  const primaryIssueCounts: Record<string, number> = {};
  const variantMatchTypeCounts: Record<string, number> = {};
  const rows: any[] = [];

  for (const normalizedHandle of allHandles) {
    const adminHandle = adminByNormalized.get(normalizedHandle);
    const remoteHandle = remoteByNormalized.get(normalizedHandle);
    const status: RowStatus =
      adminHandle && remoteHandle
        ? "both"
        : adminHandle
          ? "admin_only"
          : "shopify_only";
    const listing = adminHandle
      ? state.listings?.handleToListing?.[adminHandle]
      : null;
    const remoteListing = remoteHandle
      ? state.shopifyCatalog?.handleToListing?.[remoteHandle]
      : null;
    const itemIds = Object.entries(state.listings?.idToHandle || {})
      .filter(([_, h]) => String(h || "").trim() === adminHandle)
      .map(([id]) => id);
    const items = itemIds
      .map((id) =>
        state.inventory?.idToItem?.[id]
          ? { ...state.inventory.idToItem[id], id }
          : null,
      )
      .filter(Boolean);
    const diffDetails =
      status === "both" && listing && remoteListing
        ? diffLocalListingAgainstShopifyCatalogDetailed({
            handle: adminHandle!,
            listing,
            items,
            remoteListing,
          })
        : null;
    const issueKeys = classifyIssueKeys(status, diffDetails);
    issueKeys.forEach((key) => {
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    });
    const primaryIssue = issueKeys[0];
    primaryIssueCounts[primaryIssue] =
      (primaryIssueCounts[primaryIssue] || 0) + 1;
    (diffDetails?.variantDiffs || []).forEach((diff) => {
      variantMatchTypeCounts[diff.matchType] =
        (variantMatchTypeCounts[diff.matchType] || 0) + 1;
    });
    rows.push({
      handle: adminHandle || remoteHandle || normalizedHandle,
      status,
      issues: issueKeys,
      mismatchKeys: diffDetails?.mismatchKeys || [],
      variantDiffs: (diffDetails?.variantDiffs || []).length,
      variantMatchTypes: (diffDetails?.variantDiffs || []).map(
        (diff) => diff.matchType,
      ),
    });
  }

  return {
    handles: rows.length,
    adminHandles: adminHandles.length,
    remoteHandles: remoteHandles.length,
    issueCounts,
    primaryIssueCounts,
    variantMatchTypeCounts,
    rows: rows.filter(
      (row) => !(row.issues.length === 1 && row.issues[0] === "synced"),
    ),
  };
}

async function main() {
  const backupInput = argValue(process.argv, "--backup");
  const outPath = argValue(process.argv, "--out");
  if (!backupInput || !outPath) {
    console.error(
      "Usage: bun scripts/shopify-listing-fix-blast-radius.ts --backup <backup-dir|firestore-export.json> --out <summary.json>",
    );
    process.exit(1);
  }

  const backupPath = resolveBackupPath(backupInput);
  const actions = loadActions(backupPath);

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);
  const consoleCounts = { log: 0, warn: 0, error: 0 };
  console.log = () => {
    consoleCounts.log++;
  };
  console.warn = () => {
    consoleCounts.warn++;
  };
  console.error = () => {
    consoleCounts.error++;
  };

  let state: any = rootReducer(undefined, { type: "@@INIT" });
  let replayErrors = 0;
  const started = performance.now();
  for (const action of actions) {
    try {
      state = rootReducer(state, action, () => {});
    } catch {
      replayErrors++;
    }
  }
  const replayMs = performance.now() - started;

  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;

  const summary = {
    backupPath,
    actionCount: actions.length,
    replayErrors,
    replayMs,
    consoleCounts,
    inventory: inventoryKeySummary(state),
    shopify: shopifySummary(state),
  };

  writeFileSync(resolve(outPath), JSON.stringify(summary, null, 2));
  console.log(
    `Wrote ${outPath}: actions=${actions.length}, replayErrors=${replayErrors}, replay=${(replayMs / 1000).toFixed(1)}s`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
