#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import {
  apply_amazon_catalog_probe_chunk,
  begin_amazon_catalog_probe,
  complete_amazon_catalog_probe,
  fail_amazon_catalog_probe,
  type AmazonProbeMode,
  type AmazonRawApiResponseRecord,
  type AmazonRawResponseKind,
} from "../src/lib/amazon-catalog-slice";

type Args = Record<string, string | boolean | string[]>;

const BROADCAST_COLLECTION = "broadcast";
const LWA_TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";
const DEFAULT_INCLUDED_DATA = [
  "summaries",
  "identifiers",
  "images",
  "productTypes",
  "relationships",
  "classifications",
];
const DEFAULT_LISTINGS_INCLUDED_DATA = [
  "summaries",
  "attributes",
  "issues",
  "offers",
  "fulfillmentAvailability",
  "relationships",
  "productTypes",
];

const REGION_ENDPOINTS: Record<string, string> = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (typeof value === "string") i++;

    const existing = args[key];
    if (existing === undefined) {
      args[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      args[key] = [String(existing), String(value)];
    }
  }
  return args;
}

function getStringArg(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  if (Array.isArray(value)) return value[value.length - 1] || fallback;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function getBooleanArg(args: Args, key: string): boolean {
  return args[key] === true || args[key] === "true";
}

function getListArg(args: Args, key: string): string[] {
  const value = args[key];
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return values
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadEnvFile(path: string) {
  if (!path) return;
  if (!existsSync(path)) {
    throw new Error(`Missing env file: ${path}`);
  }

  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals < 0) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requiredEnv(keys: string[], label: string): string {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  throw new Error(`Missing ${label}. Tried: ${keys.join(", ")}`);
}

function optionalEnv(keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return fallback;
}

function getEndpoint(args: Args): string {
  const explicit = getStringArg(args, "endpoint").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const envEndpoint = optionalEnv(["AMAZON_SP_API_ENDPOINT"], "").trim();
  if (envEndpoint) return envEndpoint.replace(/\/+$/, "");

  const region = getStringArg(
    args,
    "region",
    optionalEnv(["AMAZON_SP_API_REGION"], "eu"),
  )
    .trim()
    .toLowerCase();
  const endpoint = REGION_ENDPOINTS[region];
  if (!endpoint) {
    throw new Error(
      `Unknown --region ${region}. Use one of: ${Object.keys(REGION_ENDPOINTS).join(", ")}, or pass --endpoint.`,
    );
  }
  return endpoint;
}

function getMarketplaceId(args: Args): string {
  const value = getStringArg(
    args,
    "marketplace-id",
    optionalEnv(["AMAZON_MARKETPLACE_ID", "AMAZON_SP_API_MARKETPLACE_ID"]),
  ).trim();
  if (!value) {
    throw new Error(
      "Missing marketplace ID. Set AMAZON_MARKETPLACE_ID or pass --marketplace-id.",
    );
  }
  return value;
}

function getSellerId(): string {
  return optionalEnv(["AMAZON_SELLER_ID", "AMAZON_SP_API_SELLER_ID"]).trim();
}

function getUserAgent(args: Args): string {
  return getStringArg(
    args,
    "user-agent",
    optionalEnv(
      ["AMAZON_SP_API_USER_AGENT"],
      "DobutsuAdmin/0.1 (Language=TypeScript; Runtime=Bun)",
    ),
  ).trim();
}

async function initFirestore(firestoreEnv: string) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp(
      {
        projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin",
      },
      `amazon-catalog-probe-${Date.now()}`,
    );
    const db = getFirestore(app);
    db.settings({
      host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
      ssl: false,
    });
    return db;
  }

  const keyPath = resolve(
    process.cwd(),
    `service-account-${firestoreEnv}.json`,
  );
  if (!existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  const app = initializeApp(
    { credential: cert(serviceAccount) },
    `amazon-catalog-probe-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

function amazonDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function makeRequestId(): string {
  return `amazon-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeRawResponseRecord(params: {
  requestId: string;
  kind: AmazonRawResponseKind;
  key: string;
  marketplaceId: string;
  sellerId: string;
  endpoint: string;
  response: Awaited<ReturnType<typeof spApiGet>>;
  fetchedAtMs: number;
}): AmazonRawApiResponseRecord {
  return {
    id: `${params.requestId}:${params.kind}:${params.key}`,
    requestId: params.requestId,
    kind: params.kind,
    key: params.key,
    marketplaceId: params.marketplaceId,
    sellerId: params.sellerId,
    endpoint: params.endpoint,
    requestUrl: params.response.url,
    status: params.response.status,
    statusText: params.response.statusText,
    ok: params.response.ok,
    rateLimit: params.response.rateLimit,
    fetchedAtMs: params.fetchedAtMs,
    raw: params.response.data,
  };
}

async function writeBroadcastAction(db: any, creator: string, action: any) {
  return db.collection(BROADCAST_COLLECTION).add({
    ...action,
    creator,
    timestamp: FieldValue.serverTimestamp(),
  });
}

async function writeProbeActions(params: {
  firestoreEnv: string;
  creator: string;
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId: string;
  requestedAtMs: number;
  completedAtMs: number;
  responses: AmazonRawApiResponseRecord[];
}) {
  const db = await initFirestore(params.firestoreEnv);
  await writeBroadcastAction(
    db,
    params.creator,
    begin_amazon_catalog_probe({
      requestId: params.requestId,
      mode: params.mode,
      marketplaceId: params.marketplaceId,
      sellerId: params.sellerId,
      requestedAtMs: params.requestedAtMs,
    }),
  );
  await writeBroadcastAction(
    db,
    params.creator,
    apply_amazon_catalog_probe_chunk({
      requestId: params.requestId,
      mode: params.mode,
      marketplaceId: params.marketplaceId,
      sellerId: params.sellerId,
      responses: params.responses,
    }),
  );
  await writeBroadcastAction(
    db,
    params.creator,
    complete_amazon_catalog_probe({
      requestId: params.requestId,
      mode: params.mode,
      marketplaceId: params.marketplaceId,
      sellerId: params.sellerId,
      completedAtMs: params.completedAtMs,
    }),
  );
}

async function writeProbeFailure(params: {
  firestoreEnv: string;
  creator: string;
  requestId: string;
  mode: AmazonProbeMode;
  marketplaceId: string;
  sellerId: string;
  failedAtMs: number;
  errorMessage: string;
}) {
  const db = await initFirestore(params.firestoreEnv);
  await writeBroadcastAction(
    db,
    params.creator,
    fail_amazon_catalog_probe({
      requestId: params.requestId,
      mode: params.mode,
      marketplaceId: params.marketplaceId,
      sellerId: params.sellerId,
      failedAtMs: params.failedAtMs,
      errorMessage: params.errorMessage,
    }),
  );
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function fetchLwaAccessToken() {
  const clientId = requiredEnv(
    ["AMAZON_LWA_CLIENT_ID", "AMAZON_SP_API_CLIENT_ID"],
    "Amazon LWA client ID",
  );
  const clientSecret = requiredEnv(
    ["AMAZON_LWA_CLIENT_SECRET", "AMAZON_SP_API_CLIENT_SECRET"],
    "Amazon LWA client secret",
  );
  const refreshToken = requiredEnv(
    ["AMAZON_LWA_REFRESH_TOKEN", "AMAZON_SP_API_REFRESH_TOKEN"],
    "Amazon LWA refresh token",
  );

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(LWA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      accept: "application/json",
    },
    body,
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `LWA token exchange failed (${response.status} ${response.statusText}): ${compactJson(data)}`,
    );
  }

  const accessToken = String(data.access_token || "").trim();
  if (!accessToken) {
    throw new Error(`LWA token response did not include access_token.`);
  }

  return {
    accessToken,
    expiresIn: Number(data.expires_in || 0),
    tokenType: String(data.token_type || ""),
  };
}

async function spApiGet(params: {
  endpoint: string;
  path: string;
  query: Record<string, string>;
  accessToken: string;
  userAgent: string;
}) {
  const url = new URL(params.path, params.endpoint);
  for (const [key, value] of Object.entries(params.query)) {
    if (value) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": params.userAgent,
      "x-amz-access-token": params.accessToken,
      "x-amz-date": amazonDate(),
    },
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    rateLimit: response.headers.get("x-amzn-ratelimit-limit") || "",
    url: url.toString(),
    data,
  };
}

function firstArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function summarizeCatalogItem(item: any) {
  const summaries = firstArray(item?.summaries);
  const summary = summaries[0] || {};
  const imagesSets = firstArray<any>(item?.images);
  const firstImageSet = imagesSets[0] || {};
  const firstImage = firstArray<any>(firstImageSet?.images)[0] || {};
  const productTypes = firstArray<any>(item?.productTypes)
    .map((entry) => entry?.productType || entry?.name || "")
    .filter(Boolean);
  const identifiers = firstArray<any>(item?.identifiers).flatMap((group) =>
    firstArray<any>(group?.identifiers)
      .map((identifier) => {
        const type = identifier?.identifierType || identifier?.type || "";
        const value = identifier?.identifier || identifier?.value || "";
        return type && value ? `${type}:${value}` : value;
      })
      .filter(Boolean),
  );

  return {
    asin: String(item?.asin || ""),
    title: String(summary?.itemName || summary?.title || ""),
    brand: String(summary?.brandName || summary?.brand || ""),
    manufacturer: String(summary?.manufacturer || ""),
    productTypes,
    firstImage: String(firstImage?.link || firstImage?.url || ""),
    identifiers,
    relationshipSets: firstArray(item?.relationships).length,
    classificationSets: firstArray(item?.classifications).length,
  };
}

function printCatalogResult(jan: string, response: any, showUrl: boolean) {
  if (showUrl) {
    console.log(`Request: ${response.url}`);
  }
  if (!response.ok) {
    console.log(`JAN ${jan}: ERROR ${response.status} ${response.statusText}`);
    console.log(compactJson(response.data));
    return;
  }

  const items = firstArray<any>(response.data?.items);
  const numberOfResults =
    response.data?.numberOfResults ?? response.data?.pagination?.totalResults;
  console.log(
    `JAN ${jan}: ${items.length} item(s) returned${numberOfResults === undefined ? "" : `; numberOfResults=${numberOfResults}`}`,
  );

  if (items.length === 0) {
    console.log("  No catalog match.");
    return;
  }

  for (const item of items) {
    const summary = summarizeCatalogItem(item);
    console.log(`  ASIN: ${summary.asin || "(missing)"}`);
    console.log(`    Title: ${summary.title || "(missing)"}`);
    console.log(`    Brand: ${summary.brand || "(missing)"}`);
    if (summary.manufacturer) {
      console.log(`    Manufacturer: ${summary.manufacturer}`);
    }
    console.log(
      `    Product types: ${summary.productTypes.join(", ") || "(missing)"}`,
    );
    console.log(`    First image: ${summary.firstImage || "(missing)"}`);
    console.log(
      `    Identifiers: ${summary.identifiers.slice(0, 8).join(", ") || "(missing)"}`,
    );
    console.log(`    Relationship sets: ${summary.relationshipSets}`);
    console.log(`    Classification sets: ${summary.classificationSets}`);
  }
}

function summarizeListingItem(item: any) {
  const summaries = firstArray<any>(item?.summaries);
  const summary = summaries[0] || {};
  const offers = firstArray<any>(item?.offers);
  const fulfillmentAvailability = firstArray<any>(
    item?.fulfillmentAvailability,
  );
  const productTypes = firstArray<any>(item?.productTypes)
    .map((entry) => entry?.productType || entry?.name || "")
    .filter(Boolean);
  const issues = firstArray<any>(item?.issues);

  return {
    sku: String(item?.sku || ""),
    asin: String(summary?.asin || item?.asin || ""),
    status: firstArray(summary?.status).join(", "),
    itemName: String(summary?.itemName || ""),
    productTypes,
    issueCount: issues.length,
    issues: issues.map((issue) => ({
      code: String(issue?.code || ""),
      severity: String(issue?.severity || ""),
      message: String(issue?.message || ""),
    })),
    offerCount: offers.length,
    fulfillmentAvailabilityCount: fulfillmentAvailability.length,
  };
}

function printListingsResult(label: string, response: any, showUrl: boolean) {
  if (showUrl) {
    console.log(`Listings request: ${response.url}`);
  }
  if (!response.ok) {
    console.log(
      `Seller listing ${label}: ERROR ${response.status} ${response.statusText}`,
    );
    console.log(compactJson(response.data));
    return;
  }

  const items = firstArray<any>(response.data?.items);
  console.log(`Seller listing ${label}: ${items.length} item(s) returned`);

  if (items.length === 0) {
    console.log("  No seller listing match.");
    return;
  }

  for (const item of items) {
    const summary = summarizeListingItem(item);
    console.log(`  SKU: ${summary.sku || "(missing)"}`);
    console.log(`    ASIN: ${summary.asin || "(missing)"}`);
    console.log(`    Status: ${summary.status || "(missing)"}`);
    console.log(`    Title: ${summary.itemName || "(missing)"}`);
    console.log(
      `    Product types: ${summary.productTypes.join(", ") || "(missing)"}`,
    );
    console.log(`    Offers: ${summary.offerCount}`);
    console.log(
      `    Fulfillment availability rows: ${summary.fulfillmentAvailabilityCount}`,
    );
    console.log(`    Issues: ${summary.issueCount}`);
    for (const issue of summary.issues.slice(0, 5)) {
      console.log(
        `      - ${issue.severity || "issue"} ${issue.code || ""}: ${issue.message || "(no message)"}`,
      );
    }
  }
}

async function searchCatalogByJan(params: {
  endpoint: string;
  marketplaceId: string;
  jan: string;
  identifiersType: string;
  includedData: string[];
  accessToken: string;
  userAgent: string;
  locale: string;
}) {
  return spApiGet({
    endpoint: params.endpoint,
    path: "/catalog/2022-04-01/items",
    query: {
      identifiers: params.jan,
      identifiersType: params.identifiersType,
      marketplaceIds: params.marketplaceId,
      includedData: params.includedData.join(","),
      locale: params.locale,
      pageSize: "20",
    },
    accessToken: params.accessToken,
    userAgent: params.userAgent,
  });
}

async function searchListingsByIdentifier(params: {
  endpoint: string;
  marketplaceId: string;
  sellerId: string;
  identifier: string;
  identifiersType: string;
  includedData: string[];
  accessToken: string;
  userAgent: string;
  locale: string;
}) {
  return spApiGet({
    endpoint: params.endpoint,
    path: `/listings/2021-08-01/items/${encodeURIComponent(params.sellerId)}`,
    query: {
      identifiers: params.identifier,
      identifiersType: params.identifiersType,
      marketplaceIds: params.marketplaceId,
      includedData: params.includedData.join(","),
      issueLocale: params.locale,
      pageSize: "20",
    },
    accessToken: params.accessToken,
    userAgent: params.userAgent,
  });
}

async function getListingBySku(params: {
  endpoint: string;
  marketplaceId: string;
  sellerId: string;
  sku: string;
  includedData: string[];
  accessToken: string;
  userAgent: string;
  locale: string;
}) {
  return spApiGet({
    endpoint: params.endpoint,
    path: `/listings/2021-08-01/items/${encodeURIComponent(params.sellerId)}/${encodeURIComponent(params.sku)}`,
    query: {
      marketplaceIds: params.marketplaceId,
      includedData: params.includedData.join(","),
      issueLocale: params.locale,
    },
    accessToken: params.accessToken,
    userAgent: params.userAgent,
  });
}

function showHelp() {
  console.log(`Probe Amazon Catalog Items by JAN/EAN without writing Firestore.

Usage:
  bun scripts/amazon-catalog-probe.ts --jan <jan> [--jan <jan> ...] [options]

Credentials:
  AMAZON_LWA_CLIENT_ID        or AMAZON_SP_API_CLIENT_ID
  AMAZON_LWA_CLIENT_SECRET    or AMAZON_SP_API_CLIENT_SECRET
  AMAZON_LWA_REFRESH_TOKEN    or AMAZON_SP_API_REFRESH_TOKEN
  AMAZON_MARKETPLACE_ID       or AMAZON_SP_API_MARKETPLACE_ID

Options:
  --env-file <path>           Load environment variables from a dotenv-style file
  --jan <jan>                 JAN/EAN to search; repeatable or comma-delimited
  --jan-file <path>           Newline-delimited JAN list; # comments allowed
  --marketplace-id <id>       Amazon marketplace ID
  --region <na|eu|fe>         SP-API region endpoint shortcut (default: eu)
  --endpoint <url>            Explicit SP-API endpoint
  --identifiers-type <type>   Identifier type for Catalog Items (default: JAN)
  --included-data <list>      Comma-delimited includedData list
  --seller-listings           Also search seller listings by each JAN
  --listing-identifiers-type  Seller listing identifier type (default: same as --identifiers-type)
  --sku <sku>                 Fetch a seller listing directly by SKU; repeatable or comma-delimited
  --persist-broadcast         Write replayable amazonCatalog/* actions to Firestore broadcast
  --firestore-env <env>       emulator | staging | production (default: emulator)
  --creator <id>              Broadcast creator when persisting (default: amazon-catalog-probe-cli)
  --locale <locale>           Optional locale for localized summaries
  --json                      Print raw JSON responses after compact summaries
  --raw-json-only             Print only raw JSON responses
  --show-url                  Print SP-API request URLs
  --check-token               Only exchange the LWA token; do not query catalog
  --help                      Show help

Example:
  bun scripts/amazon-catalog-probe.ts --env-file .env.amazon --marketplace-id A1F83G8C2ARO7P --jan 4542804151626
`);
}

function readJanFile(path: string): string[] {
  if (!existsSync(path)) {
    throw new Error(`Missing JAN file: ${path}`);
  }
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const envFile = getStringArg(args, "env-file", "").trim();
  if (envFile) loadEnvFile(envFile);

  const endpoint = getEndpoint(args);
  const marketplaceId = getMarketplaceId(args);
  const userAgent = getUserAgent(args);
  const identifiersType = getStringArg(args, "identifiers-type", "JAN")
    .trim()
    .toUpperCase();
  const listingIdentifiersType = getStringArg(
    args,
    "listing-identifiers-type",
    identifiersType,
  )
    .trim()
    .toUpperCase();
  const includedData = getListArg(args, "included-data");
  const listingIncludedData = getListArg(args, "listing-included-data");
  const locale = getStringArg(args, "locale", "").trim();
  const rawJsonOnly = getBooleanArg(args, "raw-json-only");
  const showJson = rawJsonOnly || getBooleanArg(args, "json");
  const showUrl = getBooleanArg(args, "show-url");
  const checkTokenOnly = getBooleanArg(args, "check-token");
  const shouldSearchSellerListings = getBooleanArg(args, "seller-listings");
  const persistBroadcast = getBooleanArg(args, "persist-broadcast");
  const firestoreEnv = getStringArg(args, "firestore-env", "emulator").trim();
  const creator = getStringArg(
    args,
    "creator",
    "amazon-catalog-probe-cli",
  ).trim();

  const token = await fetchLwaAccessToken();
  if (!rawJsonOnly) {
    console.log(
      `LWA token ok: type=${token.tokenType || "(missing)"} expiresIn=${token.expiresIn || "(missing)"}s`,
    );
    console.log(`SP-API endpoint: ${endpoint}`);
    console.log(`Marketplace: ${marketplaceId}`);
  }

  if (checkTokenOnly) return;

  const janFile = getStringArg(args, "jan-file", "").trim();
  const jans = [
    ...getListArg(args, "jan"),
    ...(janFile ? readJanFile(janFile) : []),
  ].filter((jan, index, all) => all.indexOf(jan) === index);
  const skus = getListArg(args, "sku").filter(
    (sku, index, all) => all.indexOf(sku) === index,
  );

  if (jans.length === 0 && skus.length === 0) {
    showHelp();
    throw new Error("Missing --jan, --jan-file, or --sku");
  }

  const sellerId =
    shouldSearchSellerListings || skus.length > 0 ? getSellerId() : "";
  if ((shouldSearchSellerListings || skus.length > 0) && !sellerId) {
    throw new Error(
      "Missing AMAZON_SELLER_ID. Set it in .env.amazon to use Listings Items.",
    );
  }

  const requestId = makeRequestId();
  const mode: AmazonProbeMode = skus.length > 0 ? "sku_probe" : "jan_probe";
  const requestedAtMs = Date.now();
  const responses: Record<string, any> = {};
  const rawRecords: AmazonRawApiResponseRecord[] = [];
  try {
    for (const jan of jans) {
      const response = await searchCatalogByJan({
        endpoint,
        marketplaceId,
        jan,
        identifiersType,
        includedData: includedData.length
          ? includedData
          : DEFAULT_INCLUDED_DATA,
        accessToken: token.accessToken,
        userAgent,
        locale,
      });
      responses[jan] = response.data;
      rawRecords.push(
        makeRawResponseRecord({
          requestId,
          kind: "catalog_search_by_jan",
          key: jan,
          marketplaceId,
          sellerId,
          endpoint,
          response,
          fetchedAtMs: Date.now(),
        }),
      );

      if (!rawJsonOnly) {
        printCatalogResult(jan, response, showUrl);
        if (response.rateLimit) {
          console.log(`  Rate limit header: ${response.rateLimit}`);
        }
      }

      if (shouldSearchSellerListings && sellerId) {
        const listingsResponse = await searchListingsByIdentifier({
          endpoint,
          marketplaceId,
          sellerId,
          identifier: jan,
          identifiersType: listingIdentifiersType,
          includedData: listingIncludedData.length
            ? listingIncludedData
            : DEFAULT_LISTINGS_INCLUDED_DATA,
          accessToken: token.accessToken,
          userAgent,
          locale,
        });
        responses[`${jan}:sellerListings`] = listingsResponse.data;
        rawRecords.push(
          makeRawResponseRecord({
            requestId,
            kind: "seller_listings_search_by_jan",
            key: jan,
            marketplaceId,
            sellerId,
            endpoint,
            response: listingsResponse,
            fetchedAtMs: Date.now(),
          }),
        );
        if (!rawJsonOnly) {
          printListingsResult(
            `${listingIdentifiersType}:${jan}`,
            listingsResponse,
            showUrl,
          );
          if (listingsResponse.rateLimit) {
            console.log(
              `  Listings rate limit header: ${listingsResponse.rateLimit}`,
            );
          }
        }
      }
    }

    for (const sku of skus) {
      if (!sellerId) continue;
      const listingResponse = await getListingBySku({
        endpoint,
        marketplaceId,
        sellerId,
        sku,
        includedData: listingIncludedData.length
          ? listingIncludedData
          : DEFAULT_LISTINGS_INCLUDED_DATA,
        accessToken: token.accessToken,
        userAgent,
        locale,
      });
      responses[`sku:${sku}`] = listingResponse.data;
      rawRecords.push(
        makeRawResponseRecord({
          requestId,
          kind: "seller_listing_get_by_sku",
          key: sku,
          marketplaceId,
          sellerId,
          endpoint,
          response: listingResponse,
          fetchedAtMs: Date.now(),
        }),
      );
      if (!rawJsonOnly) {
        printListingsResult(`SKU:${sku}`, listingResponse, showUrl);
        if (listingResponse.rateLimit) {
          console.log(
            `  Listings rate limit header: ${listingResponse.rateLimit}`,
          );
        }
      }
    }

    if (persistBroadcast) {
      await writeProbeActions({
        firestoreEnv,
        creator,
        requestId,
        mode,
        marketplaceId,
        sellerId,
        requestedAtMs,
        completedAtMs: Date.now(),
        responses: rawRecords,
      });
      if (!rawJsonOnly) {
        console.log(
          `Persisted ${rawRecords.length} raw Amazon response record(s) to ${firestoreEnv} ${BROADCAST_COLLECTION} with requestId ${requestId}`,
        );
      }
    }
  } catch (error) {
    if (persistBroadcast) {
      await writeProbeFailure({
        firestoreEnv,
        creator,
        requestId,
        mode,
        marketplaceId,
        sellerId,
        failedAtMs: Date.now(),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }

  if (showJson) {
    console.log(compactJson(responses));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
