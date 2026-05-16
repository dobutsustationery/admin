// CLI mirror of the SKU Review page (src/routes/sku-review/+page.svelte).
// Replays a production backup through rootReducer and computes the exact
// same exception set the GUI shows, so the two can be compared and the
// exception count driven to 0.
//
// Modes:
//   (default / --summary)  per-issue counts (the GUI filter chips)
//   --report / --csv       CSV of the review rows (GUI table + the
//                          underlying fields needed to clear exceptions)
//
// Flags (defaults mirror the GUI's default toggles):
//   --backup <path>          default ../production-backup-may-16
//   --include-out-of-stock   GUI "skip out of stock" unchecked
//   --show-hidden            GUI "show hidden" checked
//
// Usage:
//   bun run scripts/sku-review-cli.ts
//   bun run scripts/sku-review-cli.ts --report > /tmp/sku.csv
//   bun run scripts/sku-review-cli.ts --backup ../production-backup-apr-25

import { readFileSync } from "fs";
import { rootReducer } from "../src/lib/root-reducer";

type IssueCode =
  | "UNLISTED"
  | "IMAGE"
  | "DESCRIPTION"
  | "DESCRIPTION_CAPS"
  | "PRICE"
  | "COST"
  | "WEIGHT"
  | "HS_CODE"
  | "COUNTRY"
  | "CATEGORY";

// Order mirrors ISSUE_FILTERS in the page (minus the "ALL" pseudo-chip).
const ISSUE_ORDER: { code: IssueCode; label: string }[] = [
  { code: "UNLISTED", label: "Unlisted" },
  { code: "IMAGE", label: "Image" },
  { code: "DESCRIPTION", label: "Description" },
  { code: "DESCRIPTION_CAPS", label: "ALL CAPS" },
  { code: "PRICE", label: "Price" },
  { code: "COST", label: "Cost" },
  { code: "WEIGHT", label: "Weight" },
  { code: "HS_CODE", label: "HS Code" },
  { code: "COUNTRY", label: "Country" },
  { code: "CATEGORY", label: "Category" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

const backupDir = arg("--backup") || "../production-backup-may-16";
const BACKUP = `${backupDir.replace(/\/$/, "")}/firestore-export.json`;
const includeOutOfStock = flag("--include-out-of-stock");
const showHidden = flag("--show-hidden");
const reportMode = flag("--report") || flag("--csv");

function tsKey(a: any): number {
  const ts = a?.timestamp;
  if (typeof ts?._seconds === "number")
    return ts._seconds * 1_000_000_000 + (Number(ts._nanoseconds) || 0);
  if (typeof ts?.seconds === "number")
    return ts.seconds * 1_000_000_000 + (Number(ts.nanoseconds) || 0);
  return 0;
}

const raw = readFileSync(BACKUP, "utf-8");
const docs = JSON.parse(raw).collections.broadcast.documents;
const actions = docs
  .map((d: any) => ({ id: d.id, ...d.data }))
  .sort((a: any, b: any) => tsKey(a) - tsKey(b));

// Reducers log heavily during replay; silence so --report stdout is
// clean CSV (and --summary isn't drowned out). Restored after replay.
const realConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
};
console.log = console.warn = console.error = console.info = () => {};

let state: any = rootReducer(undefined, { type: "@@INIT" });
for (const a of actions) {
  try {
    state = rootReducer(state, a as any, () => {});
  } catch {
    /* mirror audit-page replay tolerance */
  }
}

console.log = realConsole.log;
console.warn = realConsole.warn;
console.error = realConsole.error;
console.info = realConsole.info;

const inv = state.inventory?.idToItem || {};
const idToHandle = state.listings?.idToHandle || {};
const handleToListing = state.listings?.handleToListing || {};
const hiddenExceptions = state.inventory?.hiddenExceptions || {};

interface Row {
  key: string;
  item: any;
  issues: IssueCode[];
  stock: number;
  listed: boolean;
  category: string;
}

const reviewItems: Row[] = [];
let totalInventory = 0;
let skippedOutOfStock = 0;

// Exact replica of the page's reactive review block.
for (const key in inv) {
  totalInventory++;
  const item = inv[key];
  const issues: IssueCode[] = [];

  if (!item.description) {
    issues.push("DESCRIPTION");
  } else if (
    item.description.length > 0 &&
    item.description === item.description.toUpperCase() &&
    /[a-z]/i.test(item.description)
  ) {
    issues.push("DESCRIPTION_CAPS");
  }

  if (!item.price) issues.push("PRICE");
  if (!item.cost) issues.push("COST");
  if (!item.weight) issues.push("WEIGHT");
  if (!item.image) issues.push("IMAGE");
  if (!item.hsCode) issues.push("HS_CODE");
  if (!item.countryOfOrigin) issues.push("COUNTRY");

  const handle = idToHandle[key];
  const listing = handle ? handleToListing[handle] : undefined;
  if (!listing || !listing.bodyHtml) issues.push("UNLISTED");
  if (listing && !listing.productCategory) issues.push("CATEGORY");

  const stock = (item.qty || 0) - (item.shipped || 0);
  if (stock <= 0) {
    skippedOutOfStock++;
    if (!includeOutOfStock) continue;
  }

  if (issues.length > 0) {
    reviewItems.push({
      key,
      item,
      issues,
      stock,
      listed: !!(listing && listing.bodyHtml),
      category: listing?.productCategory || "",
    });
  }
}

reviewItems.sort((a, b) =>
  String(b.item.creationDate || "").localeCompare(
    String(a.item.creationDate || ""),
  ),
);

const baseVisible = reviewItems.filter(
  (i) => showHidden || !hiddenExceptions[i.key],
);
const hiddenCount = reviewItems.length - baseVisible.length;

if (reportMode) {
  const cols = [
    "key",
    "janCode",
    "subtype",
    "description",
    "price",
    "cost",
    "weight",
    "hsCode",
    "countryOfOrigin",
    "image",
    "qty",
    "shipped",
    "stock",
    "listed",
    "category",
    "creationDate",
    "missing",
  ];
  const esc = (v: unknown) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out: string[] = [cols.join(",")];
  for (const r of baseVisible) {
    out.push(
      [
        r.key,
        r.item.janCode,
        r.item.subtype,
        r.item.description,
        r.item.price,
        r.item.cost,
        r.item.weight,
        r.item.hsCode,
        r.item.countryOfOrigin,
        r.item.image,
        r.item.qty,
        r.item.shipped,
        r.stock,
        r.listed,
        r.category,
        r.item.creationDate,
        r.issues.join("|"),
      ]
        .map(esc)
        .join(","),
    );
  }
  process.stdout.write(out.join("\n") + "\n");
} else {
  const counts: Record<string, number> = {};
  for (const { code } of ISSUE_ORDER) {
    counts[code] = baseVisible.filter((r) => r.issues.includes(code)).length;
  }
  const w = (s: string, n: number) => s.padEnd(n);
  console.log(`SKU Review — ${BACKUP}`);
  console.log(
    `replayed ${actions.length} actions; ` +
      `skipOutOfStock=${!includeOutOfStock} showHidden=${showHidden}`,
  );
  console.log("");
  console.log(`${w("ISSUE", 22)} COUNT`);
  console.log("-".repeat(30));
  for (const { code, label } of ISSUE_ORDER) {
    console.log(`${w(`${label} (${code})`, 22)} ${counts[code]}`);
  }
  console.log("-".repeat(30));
  console.log(`${w("ITEMS WITH EXCEPTIONS", 22)} ${baseVisible.length}`);
  console.log("");
  console.log(`total inventory items   : ${totalInventory}`);
  console.log(`out-of-stock skipped    : ${skippedOutOfStock}`);
  console.log(`hidden (excluded)       : ${hiddenCount}`);
  console.log(
    baseVisible.length === 0
      ? "\n✅ 0 exceptions — SKU review is clean."
      : `\n⚠️  ${baseVisible.length} items still need attention.`,
  );
}
