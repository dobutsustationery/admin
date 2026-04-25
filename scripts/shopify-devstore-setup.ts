#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const core = require("../functions/shared/shopify-sync-core.cjs");

type Args = Record<string, string | boolean | string[]>;

type ShopifyConfig = {
  storeUrl: string;
  accessToken: string;
  clientId: string;
  clientSecret: string;
  apiVersion: string;
};

type WebhookSubscription = {
  id: string;
  topic: string;
  uri: string;
  endpoint?: {
    __typename?: string;
    callbackUrl?: string;
    arn?: string;
    pubSubProject?: string;
    pubSubTopic?: string;
  };
  apiVersion?: {
    handle?: string;
  };
};

const DEFAULT_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
];

const REQUIRED_SCOPES = ["read_orders"];

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value =
      inlineValue !== undefined
        ? inlineValue
        : !next || next.startsWith("--")
          ? true
          : next;

    if (inlineValue === undefined && typeof value === "string") i++;

    if (key === "topic") {
      const existing = args[key];
      args[key] = [
        ...(Array.isArray(existing)
          ? existing
          : existing
            ? [String(existing)]
            : []),
        String(value),
      ];
    } else {
      args[key] = value;
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

function getBooleanArg(args: Args, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

function getTopics(args: Args): string[] {
  const raw = args.topic;
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : DEFAULT_TOPICS;
  return values
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
}

function showHelp() {
  console.log(`Set up and verify a Shopify development store for order webhooks.

Usage:
  bun scripts/shopify-devstore-setup.ts [options]

Options:
  --env <name>             Environment file suffix to load (default: staging)
  --env-file <path>        Explicit dotenv file path
  --store <domain>         Store domain, e.g. dobutsudev.myshopify.com
  --webhook-url <url>      HTTPS endpoint for order webhooks
  --api-version <version>  Admin API version (default: env or 2026-01)
  --topic <topic>          GraphQL webhook topic; repeatable or comma-separated
  --canary-sku <sku>       Verify a product variant exists for this SKU
  --apply                  Create/update Shopify webhook subscriptions
  --help                   Show help

Required env vars in the selected env file:
  SHOPIFY_STORE_URL
  SHOPIFY_ACCESS_TOKEN
    OR
  SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
`);
}

function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  const content = readFileSync(path, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    env[match[1]] = value;
  }
  return env;
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) {
    throw new Error(`Missing env file: ${path}`);
  }
  const values = parseEnvFile(path);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return values;
}

function normalizeWebhookUrl(raw: string): string {
  const value = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https:\/\//.test(value)) {
    throw new Error(`Webhook URL must be https://, got: ${value}`);
  }
  return value;
}

function normalizeComparableUri(raw: string): string {
  const value = String(raw || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

function buildShopifyConfig(args: Args): ShopifyConfig {
  const storeUrl = core.normalizeStoreUrl(
    getStringArg(args, "store", process.env.SHOPIFY_STORE_URL || ""),
  );
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  const apiVersion = getStringArg(
    args,
    "api-version",
    process.env.SHOPIFY_API_VERSION || "2026-01",
  );
  return { storeUrl, accessToken, clientId, clientSecret, apiVersion };
}

function validateConfig(config: ShopifyConfig) {
  if (!config.storeUrl) throw new Error("Missing SHOPIFY_STORE_URL");
  if (!core.hasAnyCredentials(config)) {
    throw new Error(
      "Missing Shopify credentials: set SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET",
    );
  }
}

function displayCredentialMode(config: ShopifyConfig): string {
  if (config.accessToken) return "SHOPIFY_ACCESS_TOKEN";
  return "SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET";
}

function getSubscriptionUri(subscription: WebhookSubscription): string {
  return (
    subscription.uri ||
    subscription.endpoint?.callbackUrl ||
    subscription.endpoint?.arn ||
    [subscription.endpoint?.pubSubProject, subscription.endpoint?.pubSubTopic]
      .filter(Boolean)
      .join(":")
  );
}

async function shopifyGraphql<T>(
  config: ShopifyConfig,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const url = `https://${config.storeUrl}/admin/api/${config.apiVersion}/graphql.json`;
  const headers = await core.buildShopifyHeaders(config);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

function assertUserErrors(
  action: string,
  userErrors: Array<{ field?: string[]; message?: string }> | undefined,
) {
  if (!Array.isArray(userErrors) || userErrors.length === 0) return;
  throw new Error(`${action} failed: ${JSON.stringify(userErrors)}`);
}

async function fetchStoreInfo(config: ShopifyConfig) {
  return shopifyGraphql<{
    shop: { name: string; myshopifyDomain: string };
    currentAppInstallation?: { accessScopes?: Array<{ handle: string }> };
  }>(
    config,
    `query DevstoreSetupInfo {
      shop {
        name
        myshopifyDomain
      }
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
    }`,
  );
}

async function fetchWebhookSubscriptions(
  config: ShopifyConfig,
  topics: string[],
): Promise<WebhookSubscription[]> {
  const subscriptions: WebhookSubscription[] = [];
  let after: string | null = null;

  do {
    const data = await shopifyGraphql<{
      webhookSubscriptions: {
        edges: Array<{
          cursor: string;
          node: WebhookSubscription;
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    }>(
      config,
      `query DevstoreWebhookSubscriptions($first: Int!, $after: String, $topics: [WebhookSubscriptionTopic!]) {
        webhookSubscriptions(first: $first, after: $after, topics: $topics) {
          edges {
            cursor
            node {
              id
              topic
              uri
              endpoint {
                __typename
                ... on WebhookHttpEndpoint {
                  callbackUrl
                }
                ... on WebhookEventBridgeEndpoint {
                  arn
                }
                ... on WebhookPubSubEndpoint {
                  pubSubProject
                  pubSubTopic
                }
              }
              apiVersion {
                handle
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first: 100, after, topics },
    );

    for (const edge of data.webhookSubscriptions.edges) {
      subscriptions.push(edge.node);
    }
    after = data.webhookSubscriptions.pageInfo.hasNextPage
      ? data.webhookSubscriptions.pageInfo.endCursor
      : null;
  } while (after);

  return subscriptions;
}

async function createWebhookSubscription(
  config: ShopifyConfig,
  topic: string,
  uri: string,
) {
  const data = await shopifyGraphql<{
    webhookSubscriptionCreate: {
      webhookSubscription: WebhookSubscription | null;
      userErrors: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    config,
    `mutation DevstoreWebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { topic, webhookSubscription: { uri } },
  );
  assertUserErrors(
    `webhookSubscriptionCreate(${topic})`,
    data.webhookSubscriptionCreate.userErrors,
  );
  return data.webhookSubscriptionCreate.webhookSubscription;
}

async function updateWebhookSubscription(
  config: ShopifyConfig,
  id: string,
  uri: string,
) {
  const data = await shopifyGraphql<{
    webhookSubscriptionUpdate: {
      webhookSubscription: WebhookSubscription | null;
      userErrors: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    config,
    `mutation DevstoreWebhookUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }`,
    { id, webhookSubscription: { uri } },
  );
  assertUserErrors(
    `webhookSubscriptionUpdate(${id})`,
    data.webhookSubscriptionUpdate.userErrors,
  );
  return data.webhookSubscriptionUpdate.webhookSubscription;
}

async function findCanarySku(config: ShopifyConfig, sku: string) {
  const data = await shopifyGraphql<{
    productVariants: {
      nodes: Array<{
        id: string;
        sku: string;
        displayName: string;
        product: {
          id: string;
          handle: string;
          title: string;
        };
      }>;
    };
  }>(
    config,
    `query DevstoreCanarySku($query: String!) {
      productVariants(first: 10, query: $query) {
        nodes {
          id
          sku
          displayName
          product {
            id
            handle
            title
          }
        }
      }
    }`,
    { query: `sku:${sku}` },
  );
  return data.productVariants.nodes;
}

function summarizeScopes(handles: string[]) {
  if (handles.length === 0) return "unknown";
  return handles.sort().join(", ");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const envName = getStringArg(args, "env", "staging");
  const envFile = resolve(
    process.cwd(),
    getStringArg(args, "env-file", `.env.${envName}`),
  );
  loadEnvFile(envFile);

  const config = buildShopifyConfig(args);
  validateConfig(config);

  const topics = getTopics(args);
  const apply = getBooleanArg(args, "apply", false);
  const webhookUrl = normalizeWebhookUrl(
    getStringArg(
      args,
      "webhook-url",
      process.env.SHOPIFY_ORDER_WEBHOOK_URL || "",
    ),
  );
  const canarySku = getStringArg(args, "canary-sku", "").trim();

  if (!webhookUrl) {
    throw new Error(
      "Missing --webhook-url or SHOPIFY_ORDER_WEBHOOK_URL. Pass the deployed shopifyOrderWebhook HTTPS URL.",
    );
  }

  console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
  console.log(`Env file: ${envFile}`);
  console.log(`Store: ${config.storeUrl}`);
  console.log(`Admin API version: ${config.apiVersion}`);
  console.log(`Credential mode: ${displayCredentialMode(config)}`);
  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`Topics: ${topics.join(", ")}`);

  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET || "";
  if (
    webhookSecret &&
    config.clientSecret &&
    webhookSecret !== config.clientSecret
  ) {
    console.warn(
      "Warning: SHOPIFY_WEBHOOK_SECRET is set but differs from SHOPIFY_CLIENT_SECRET. The deployed webhook currently validates HMAC with SHOPIFY_CLIENT_SECRET.",
    );
  }

  const storeInfo = await fetchStoreInfo(config);
  console.log(
    `Connected shop: ${storeInfo.shop.name} (${storeInfo.shop.myshopifyDomain})`,
  );

  const accessScopes =
    storeInfo.currentAppInstallation?.accessScopes?.map(
      (scope) => scope.handle,
    ) || [];
  console.log(`Access scopes: ${summarizeScopes(accessScopes)}`);
  for (const requiredScope of REQUIRED_SCOPES) {
    if (!accessScopes.includes(requiredScope)) {
      console.warn(`Warning: missing expected scope ${requiredScope}`);
    }
  }

  const subscriptions = await fetchWebhookSubscriptions(config, topics);
  const byTopic = new Map<string, WebhookSubscription[]>();
  for (const subscription of subscriptions) {
    const list = byTopic.get(subscription.topic) || [];
    list.push(subscription);
    byTopic.set(subscription.topic, list);
  }

  let changesNeeded = 0;
  for (const topic of topics) {
    const existing = byTopic.get(topic) || [];
    const exact = existing.find(
      (sub) =>
        normalizeComparableUri(getSubscriptionUri(sub)) ===
        normalizeComparableUri(webhookUrl),
    );
    if (exact) {
      console.log(`OK ${topic}: ${exact.id} already points to ${webhookUrl}`);
      if (existing.length > 1) {
        console.warn(
          `Warning: ${topic} has ${existing.length - 1} additional subscription(s) for this app.`,
        );
      }
      continue;
    }

    changesNeeded++;
    const firstForTopic = existing[0];
    if (!firstForTopic) {
      if (apply) {
        const created = await createWebhookSubscription(
          config,
          topic,
          webhookUrl,
        );
        console.log(`Created ${topic}: ${created?.id || "unknown id"}`);
      } else {
        console.log(`Would create ${topic} -> ${webhookUrl}`);
      }
      continue;
    }

    const currentUri =
      getSubscriptionUri(firstForTopic) || "(unknown endpoint)";
    if (apply) {
      const updated = await updateWebhookSubscription(
        config,
        firstForTopic.id,
        webhookUrl,
      );
      console.log(
        `Updated ${topic}: ${updated?.id || firstForTopic.id} from ${currentUri} to ${webhookUrl}`,
      );
    } else {
      console.log(
        `Would update ${topic}: ${firstForTopic.id} from ${currentUri} to ${webhookUrl}`,
      );
    }
  }

  if (canarySku) {
    const variants = await findCanarySku(config, canarySku);
    if (variants.length === 0) {
      console.warn(
        `Warning: no Shopify variant found for canary SKU ${canarySku}`,
      );
    } else {
      for (const variant of variants) {
        console.log(
          `Canary SKU ${canarySku}: ${variant.displayName} (${variant.product.handle})`,
        );
      }
    }
  }

  if (!apply && changesNeeded > 0) {
    console.log(
      `Dry run complete: ${changesNeeded} change(s) needed. Re-run with --apply to make them.`,
    );
  } else if (!apply) {
    console.log("Dry run complete: no webhook changes needed.");
  } else {
    console.log("Apply complete.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
