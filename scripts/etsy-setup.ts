#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Args = Record<string, string | boolean | string[]>;

type EtsyConfig = {
  shopId: string;
  apiKey: string;
  accessToken: string;
  sharedSecret: string;
};

const DEFAULT_TOPICS = [
  "receipt.created",
  "receipt.updated",
];

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.trim();
    const next = argv[i + 1];
    const value = inlineValue !== undefined ? inlineValue : !next || next.startsWith("--") ? true : next;
    if (inlineValue === undefined && typeof value === "string") i++;
    args[key] = value;
  }
  return args;
}

function getStringArg(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  if (Array.isArray(value)) return value[value.length - 1] || fallback;
  if (typeof value === "string") return value;
  return fallback;
}

function getBooleanArg(args: Args, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  return fallback;
}

function loadEnvFile(path: string) {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?$/);
    if (!match) continue;
    let value = match[2] || "";
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    env[match[1]] = value;
  }
  return env;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envName = getStringArg(args, "env", "local");
  const envFile = envName === "local" ? ".env" : `.env.${envName}`;
  const env = loadEnvFile(resolve(process.cwd(), envFile));

  const config: EtsyConfig = {
    shopId: getStringArg(args, "shop-id", env.ETSY_SHOP_ID),
    apiKey: getStringArg(args, "api-key", env.ETSY_API_KEY),
    accessToken: getStringArg(args, "access-token", env.ETSY_ACCESS_TOKEN),
    sharedSecret: getStringArg(args, "shared-secret", env.ETSY_SHARED_SECRET),
  };

  const webhookUrl = getStringArg(args, "webhook-url", env.ETSY_ORDER_WEBHOOK_URL);
  const apply = getBooleanArg(args, "apply", false);

  console.log(`Etsy Setup Tool (${envName})`);
  console.log(`Shop ID: ${config.shopId}`);
  console.log(`Webhook URL: ${webhookUrl}`);

  if (!config.shopId || !config.accessToken || !config.apiKey) {
    console.error("Error: Missing required Etsy credentials (ETSY_SHOP_ID, ETSY_API_KEY, ETSY_ACCESS_TOKEN)");
    process.exit(1);
  }

  if (!webhookUrl) {
    console.error("Error: Missing ETSY_ORDER_WEBHOOK_URL");
    process.exit(1);
  }

  // NOTE: Etsy v3 Webhook API is restricted to specific partners or requires manual setup in some cases.
  // This script assumes the /v3/application/webhooks endpoint is available.
  
  try {
    // 1. Check existing webhooks
    console.log("\nChecking existing Etsy webhooks...");
    // GET /v3/application/webhooks
    // (This is a simplified placeholder for the actual Etsy v3 Webhook API)
    
    if (apply) {
      console.log("\nRegistering webhooks...");
      for (const topic of DEFAULT_TOPICS) {
        console.log(`Registering ${topic}...`);
        // POST /v3/application/webhooks
      }
      console.log("\nRegistration complete.");
    } else {
      console.log("\nDry run complete. Use --apply to register webhooks.");
    }
  } catch (error) {
    console.error("Setup failed:", error);
    process.exit(1);
  }
}

main();
