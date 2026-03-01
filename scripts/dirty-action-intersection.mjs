#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = process.cwd();
const EXPORT_PATH = resolve(ROOT, "test-data/firestore-export.json");
const AUDIT_PATH = resolve(ROOT, "ACTION_AUDIT.md");
const OUT_JSON = resolve(ROOT, "test-data/dirty-action-intersection.json");

function parseDirtyTypesFromAudit(markdown) {
  const start = markdown.indexOf("## Dirty / wrong");
  if (start === -1) return [];
  const tail = markdown.slice(start);
  const nextHeader = tail.indexOf("\n## ");
  const section = nextHeader === -1 ? tail : tail.slice(0, nextHeader);

  const types = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^\s*-\s+`([^`]+)`/);
    if (!m) continue;
    const v = m[1].trim();
    if (!v || v.includes(" ")) continue;
    types.push(v);
  }
  return Array.from(new Set(types));
}

function addCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function main() {
  const audit = readFileSync(AUDIT_PATH, "utf8");
  const dirtyTypes = parseDirtyTypesFromAudit(audit);

  const raw = readFileSync(EXPORT_PATH, "utf8");
  const parsed = JSON.parse(raw);
  const broadcast = parsed?.collections?.broadcast || [];

  const typeCounts = new Map();
  const dirtyCounts = new Map();

  // Per-dirty-type payload diagnostics for compatibility planning.
  const diagnostics = {
    update_field: {
      total: 0,
      withFrom: 0,
      missingFrom: 0,
      withTo: 0,
      fieldCounts: {},
    },
    make_sales: {
      total: 0,
      withDate: 0,
      dateTypeCounts: {},
    },
    update_item: {
      total: 0,
      payloadHasItem: 0,
      itemHasQty: 0,
      itemHasShipped: 0,
      itemHasTimestamp: 0,
      itemHasCreationDate: 0,
    },
    retype_item: {
      total: 0,
      withQty: 0,
      withJanCode: 0,
      withSubtype: 0,
    },
    "listingCreation/add_proposals": {
      total: 0,
      payloadIsArray: 0,
      proposalsWithVariantsQty: 0,
      proposalsTotal: 0,
    },
  };

  for (const doc of broadcast) {
    const action = doc?.data || {};
    const type = action?.type;
    if (!type) continue;

    addCount(typeCounts, type);
    const payload = action?.payload;

    if (dirtyTypes.includes(type)) {
      addCount(dirtyCounts, type);
    }

    if (type === "update_field") {
      diagnostics.update_field.total += 1;
      if (payload && Object.prototype.hasOwnProperty.call(payload, "from")) {
        diagnostics.update_field.withFrom += 1;
      } else {
        diagnostics.update_field.missingFrom += 1;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, "to")) {
        diagnostics.update_field.withTo += 1;
      }
      if (payload?.field) {
        diagnostics.update_field.fieldCounts[payload.field] =
          (diagnostics.update_field.fieldCounts[payload.field] || 0) + 1;
      }
    } else if (type === "make_sales") {
      diagnostics.make_sales.total += 1;
      if (payload && Object.prototype.hasOwnProperty.call(payload, "date")) {
        diagnostics.make_sales.withDate += 1;
        const dt = payload?.date?._datatype || typeof payload.date;
        diagnostics.make_sales.dateTypeCounts[dt] =
          (diagnostics.make_sales.dateTypeCounts[dt] || 0) + 1;
      }
    } else if (type === "update_item") {
      diagnostics.update_item.total += 1;
      if (payload?.item && typeof payload.item === "object") {
        diagnostics.update_item.payloadHasItem += 1;
        if (Object.prototype.hasOwnProperty.call(payload.item, "qty"))
          diagnostics.update_item.itemHasQty += 1;
        if (Object.prototype.hasOwnProperty.call(payload.item, "shipped"))
          diagnostics.update_item.itemHasShipped += 1;
        if (Object.prototype.hasOwnProperty.call(payload.item, "timestamp"))
          diagnostics.update_item.itemHasTimestamp += 1;
        if (Object.prototype.hasOwnProperty.call(payload.item, "creationDate"))
          diagnostics.update_item.itemHasCreationDate += 1;
      }
    } else if (type === "retype_item") {
      diagnostics.retype_item.total += 1;
      if (Object.prototype.hasOwnProperty.call(payload || {}, "qty"))
        diagnostics.retype_item.withQty += 1;
      if (Object.prototype.hasOwnProperty.call(payload || {}, "janCode"))
        diagnostics.retype_item.withJanCode += 1;
      if (Object.prototype.hasOwnProperty.call(payload || {}, "subtype"))
        diagnostics.retype_item.withSubtype += 1;
    } else if (type === "listingCreation/add_proposals") {
      diagnostics["listingCreation/add_proposals"].total += 1;
      if (Array.isArray(payload)) {
        diagnostics["listingCreation/add_proposals"].payloadIsArray += 1;
        diagnostics["listingCreation/add_proposals"].proposalsTotal +=
          payload.length;
        for (const p of payload) {
          for (const v of p?.variants || []) {
            if (Object.prototype.hasOwnProperty.call(v, "qty")) {
              diagnostics[
                "listingCreation/add_proposals"
              ].proposalsWithVariantsQty += 1;
            }
          }
        }
      }
    }
  }

  const allTypes = [...typeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));
  const dirtyIntersection = [...dirtyCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  const result = {
    source: "test-data/firestore-export.json",
    totalBroadcastDocs: broadcast.length,
    totalActionTypes: allTypes.length,
    dirtyTypesFromAudit: dirtyTypes,
    dirtyTypesPresentInProduction: dirtyIntersection.map((x) => x.type),
    dirtyIntersection,
    diagnostics,
    generatedAt: new Date().toISOString(),
  };

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));
  console.log(`Wrote ${OUT_JSON}`);
  console.log(
    `Dirty intersection: ${dirtyIntersection.map((x) => `${x.type} (${x.count})`).join(", ") || "none"}`,
  );
}

main();
