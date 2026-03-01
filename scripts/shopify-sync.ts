#!/usr/bin/env bun

import { spawnSync } from "node:child_process";

function showHelp() {
  console.log(`Shopify sync wrapper (backward compatibility)

Preferred tools:
  bun scripts/shopify-sync-request.ts --handle <handle> --firestore-env <env>
  bun scripts/shopify-sync-worker.ts --firestore-env <env> [--request-doc-id <id>]

Wrapper behavior:
  --sync-listing-handle <handle>  -> queues one request via shopify-sync-request.ts
  --process-requests              -> runs worker via shopify-sync-worker.ts
  (no args)                       -> runs worker via shopify-sync-worker.ts
`);
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  showHelp();
  process.exit(0);
}

const handleIndex = args.indexOf("--sync-listing-handle");
if (handleIndex !== -1) {
  const handle = args[handleIndex + 1];
  if (!handle || handle.startsWith("--")) {
    console.error("Missing value for --sync-listing-handle");
    process.exit(1);
  }

  const passArgs = args.filter(
    (arg, idx) => idx !== handleIndex && idx !== handleIndex + 1,
  );
  const result = spawnSync(
    "bun",
    ["scripts/shopify-sync-request.ts", "--handle", handle, ...passArgs],
    {
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

const filteredArgs = args.filter(
  (arg) => arg !== "--process-requests" && arg !== "--apply",
);
const result = spawnSync(
  "bun",
  ["scripts/shopify-sync-worker.ts", ...filteredArgs],
  {
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
