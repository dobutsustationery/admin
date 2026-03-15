#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

const targets = [
  { file: "src/lib/inventory.ts", mode: "full" },
  { file: "src/lib/listings-slice.ts", mode: "full" },
  { file: "src/lib/photos-slice.ts", mode: "full" },
  { file: "src/lib/root-reducer.ts", mode: "full" },
  { file: "src/lib/shopify-import-slice.ts", mode: "full" },
  { file: "src/lib/sync-queue-slice.ts", mode: "full" },
  {
    file: "src/lib/listing-creation-slice.ts",
    mode: "before_marker",
    marker: "// --- Thunks ---",
  },
];

function findDateNowLines(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, index) => {
    if (line.includes("Date.now(")) {
      hits.push(index + 1);
    }
  });
  return hits;
}

function findCreatedAtReducerLines(text) {
  const lines = text.split("\n");
  const hits = [];
  lines.forEach((line, index) => {
    if (
      line.includes("payload.createdAt") ||
      line.includes("createdAt?:") ||
      line.includes("createdAt:")
    ) {
      hits.push(index + 1);
    }
  });
  return hits;
}

const violations = [];
const createdAtViolations = [];

for (const target of targets) {
  const abs = path.resolve(root, target.file);
  const content = fs.readFileSync(abs, "utf8");
  let inspected = content;

  if (target.mode === "before_marker") {
    const markerIndex = content.indexOf(target.marker);
    if (markerIndex >= 0) {
      inspected = content.slice(0, markerIndex);
    }
  }

  const lines = findDateNowLines(inspected);
  if (lines.length > 0) {
    violations.push({ file: target.file, lines });
  }

  const createdAtLines = findCreatedAtReducerLines(inspected);
  if (createdAtLines.length > 0) {
    createdAtViolations.push({ file: target.file, lines: createdAtLines });
  }
}

if (violations.length > 0) {
  console.error(
    "[no-date-now-in-reducers] Found Date.now() usage in reducer files:",
  );
  for (const v of violations) {
    console.error(`  - ${v.file}: ${v.lines.join(", ")}`);
  }
  process.exit(1);
}

if (createdAtViolations.length > 0) {
  console.error(
    "[no-date-now-in-reducers] Found createdAt usage in reducer files (use action._timestamp):",
  );
  for (const v of createdAtViolations) {
    console.error(`  - ${v.file}: ${v.lines.join(", ")}`);
  }
  process.exit(1);
}

console.log("[no-date-now-in-reducers] OK");
