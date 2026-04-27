#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";

type Args = Record<string, string | boolean | string[]>;

type EtsyConfig = {
  shopId: string;
  apiKey: string;
  accessToken: string;
  sharedSecret: string;
};

const DEFAULT_TOPICS = ["receipt.created", "receipt.updated"];

const ETSY_SCOPES = [
  "transactions_r", // Read receipts/transactions
  "transactions_w", // Update receipts (e.g. mark as shipped)
  "listings_r",     // Read listings for mapping
];

function generateRandomString(length: number): string {
  return crypto.randomBytes(length).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return hash.toString("base64url");
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

  const webhookUrl = getStringArg(
    args,
    "webhook-url",
    env.ETSY_ORDER_WEBHOOK_URL,
  );
  const apply = getBooleanArg(args, "apply", false);
  const isTokenRequest = getBooleanArg(args, "token", false);
  const exchangeCode = getStringArg(args, "exchange", "");

  console.log(`Etsy Setup Tool (${envName})`);

  if (isTokenRequest) {
    if (!config.apiKey) {
      console.error("Error: Missing ETSY_API_KEY (Keystring)");
      process.exit(1);
    }
    const verifier = generateRandomString(32);
    const challenge = generateCodeChallenge(verifier);
    const state = generateRandomString(16);
    const redirectUri = getStringArg(args, "redirect-uri", "https://localhost");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.apiKey,
      redirect_uri: redirectUri,
      scope: ETSY_SCOPES.join(" "),
      state: state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });

    console.log("\n--- ETSY OAUTH SETUP ---");
    console.log("1. Save this CODE VERIFIER (you will need it for --exchange):");
    console.log(`   ${verifier}`);
    console.log("\n2. Open this URL in your browser and authorize the app:");
    console.log(`   https://www.etsy.com/oauth/connect?${params.toString()}`);
    console.log("\n3. After authorizing, you will be redirected to your redirect URI.");
    console.log("   Copy the 'code' parameter from the URL.");
    console.log("\n4. Run this script again with:");
    console.log(`   bun scripts/etsy-setup.ts --env ${envName} --exchange <code> --verifier ${verifier}`);
    return;
  }

  if (exchangeCode) {
    const verifier = getStringArg(args, "verifier", "");
    if (!verifier) {
      console.error("Error: Missing --verifier (saved from step 1)");
      process.exit(1);
    }
    const redirectUri = getStringArg(args, "redirect-uri", "https://localhost");

    console.log("Exchanging code for access token...");
    const response = await fetch("https://api.etsy.com/v3/public/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.apiKey,
        redirect_uri: redirectUri,
        code: exchangeCode,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`Exchange failed: ${err}`);
      process.exit(1);
    }

    const data = await response.json();
    console.log("\n--- SUCCESS ---");
    console.log("Access Token:", data.access_token);
    console.log("Refresh Token:", data.refresh_token);
    
    if (envName === "local") {
      updateEnvFile(resolve(process.cwd(), ".env"), {
        ETSY_ACCESS_TOKEN: data.access_token,
      });
      console.log("\nUpdated .env with new access token.");
    } else {
      console.log(`\nPlease update ${envFile} with:`);
      console.log(`ETSY_ACCESS_TOKEN=${data.access_token}`);
    }
    return;
  }

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

  try {
    // 1. Check existing webhooks
    console.log("\nChecking existing Etsy webhooks...");
    const listResponse = await fetch(`https://openapi.etsy.com/v3/application/shops/${config.shopId}/webhooks`, {
      headers: {
        "x-api-key": config.apiKey,
        "Authorization": `Bearer ${config.accessToken}`,
      }
    });

    if (listResponse.ok) {
      const listData = await listResponse.json();
      console.log(`Found ${listData.count || 0} existing webhooks.`);
    } else {
      console.log("Could not list webhooks (endpoint might be restricted).");
    }
    
    if (apply) {
      console.log("\nRegistering webhooks...");
      for (const topic of DEFAULT_TOPICS) {
        console.log(`Registering ${topic}...`);
        const regResponse = await fetch(`https://openapi.etsy.com/v3/application/shops/${config.shopId}/webhooks`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "x-api-key": config.apiKey,
            "Authorization": `Bearer ${config.accessToken}`,
          },
          body: new URLSearchParams({
            topic,
            url: webhookUrl,
          })
        });

        if (regResponse.ok) {
          const regData = await regResponse.json();
          console.log(`Successfully registered ${topic}. Shared Secret: ${regData.shared_secret}`);
          if (envName === "local") {
             updateEnvFile(resolve(process.cwd(), ".env"), {
               ETSY_SHARED_SECRET: regData.shared_secret
             });
          }
        } else {
          const err = await regResponse.text();
          console.error(`Failed to register ${topic}: ${err}`);
        }
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

function updateEnvFile(path: string, updates: Record<string, string>) {
  let content = "";
  if (existsSync(path)) {
    content = readFileSync(path, "utf-8");
  }
  
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += `\n${key}=${value}\n`;
    }
  }
  
  writeFileSync(path, content.trim() + "\n");
}

main();
