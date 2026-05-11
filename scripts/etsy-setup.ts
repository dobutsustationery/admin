#!/usr/bin/env bun

/**
 * Etsy setup tool.
 *
 * Runs the minimum number of API calls needed to provision Etsy for
 * one environment (emulator/staging/production), writing all
 * discovered values back to the appropriate `.env.<env>` file.
 *
 * Usage:
 *   bun scripts/etsy-setup.ts --env staging
 *
 * One-time prerequisite: ETSY_API_KEY (keystring) must already be in
 * `.env.<env>`.  Everything else is discovered or interactively
 * captured and persisted.
 *
 * On a fresh setup the script will:
 *   1. Run OAuth PKCE if ETSY_ACCESS_TOKEN is missing.  Opens the
 *      browser; prompts for the redirect 'code' from the URL bar.
 *   2. Discover ETSY_SHOP_ID via /v3/application/users/me.
 *   3. If ETSY_ORDER_WEBHOOK_URL isn't set yet, prompt for it (the
 *      URL only exists after the first functions deploy).  Or pass
 *      --webhook-url <url>.
 *   4. List existing webhooks; register any missing topics; capture
 *      shared_secret and persist as ETSY_SHARED_SECRET.
 *
 * Re-running is safe and idempotent: it skips any step whose output
 * is already in env.
 *
 * Flags:
 *   --env <name>           env name (default emulator)
 *   --webhook-url <url>    override ETSY_ORDER_WEBHOOK_URL
 *   --redirect-uri <url>   OAuth redirect (default https://localhost)
 *   --reauth               force OAuth even if token exists
 *   --dry-run              don't write env or register webhooks
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

type Args = Record<string, string | boolean | string[]>;

const DEFAULT_TOPICS = ["receipt.created", "receipt.updated"];

const ETSY_SCOPES = [
  "transactions_r",
  "transactions_w",
  "listings_r",
];

function generateRandomString(length: number): string {
  return crypto.randomBytes(length).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function getStringArg(args: Args, key: string, fallback = ""): string {
  const v = args[key];
  return typeof v === "string" ? v : fallback;
}

function getBooleanArg(args: Args, key: string, fallback = false): boolean {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v !== "false";
  return fallback;
}

function loadEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const content = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function updateEnvFile(path: string, updates: Record<string, string>) {
  let content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content += (content.endsWith("\n") || content === "" ? "" : "\n") +
        `${key}=${value}\n`;
    }
  }
  writeFileSync(path, content);
}

function envFilePathFor(envName: string): string {
  // Mirror prepare-functions-env.js: "local" → .env.emulator.
  if (envName === "local" || envName === "emulator") {
    return resolve(process.cwd(), ".env.emulator");
  }
  return resolve(process.cwd(), `.env.${envName}`);
}

function resolveProjectId(envName: string): string | null {
  const firebasercPath = resolve(process.cwd(), ".firebaserc");
  if (!existsSync(firebasercPath)) return null;
  const firebaserc = JSON.parse(readFileSync(firebasercPath, "utf-8"));
  return (
    firebaserc.projects?.[envName] ||
    firebaserc.projects?.default ||
    null
  );
}

function findEtsyWebhookUrl(node: any): string | null {
  // Walk an arbitrary JSON tree looking for an entry that names the etsy
  // webhook function and exposes a URL.  The Firebase CLI's
  // functions:list --json output format varies by version, so we accept
  // any of: top-level array, { result: [...] }, { functions: [...] }, or
  // an object keyed by function name.
  const looksLikeEntry = (entry: any): boolean => {
    if (!entry || typeof entry !== "object") return false;
    const name =
      entry.id || entry.name || entry.functionName || entry.entryPoint || "";
    return String(name).toLowerCase().includes("etsyorderwebhook");
  };
  const extractUrl = (entry: any): string | null => {
    if (!entry) return null;
    return (
      entry.url ||
      entry.uri ||
      entry.httpsTrigger?.url ||
      entry.serviceConfig?.uri ||
      entry.eventTrigger?.url ||
      null
    );
  };

  if (Array.isArray(node)) {
    for (const entry of node) {
      if (looksLikeEntry(entry)) {
        const url = extractUrl(entry);
        if (url) return url;
      }
      const nested = findEtsyWebhookUrl(entry);
      if (nested) return nested;
    }
    return null;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (
        String(key).toLowerCase().includes("etsyorderwebhook") &&
        value &&
        typeof value === "object"
      ) {
        const url = extractUrl(value);
        if (url) return url;
      }
      if (looksLikeEntry(value)) {
        const url = extractUrl(value);
        if (url) return url;
      }
      const nested = findEtsyWebhookUrl(value);
      if (nested) return nested;
    }
  }
  return null;
}

function discoverWebhookUrlFromFirebase(envName: string): string | null {
  const projectId = resolveProjectId(envName);
  if (!projectId) return null;
  let raw: string;
  try {
    raw = execSync(
      `npx --no-install firebase functions:list --project ${projectId} --json`,
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (e: any) {
    const stderr = e?.stderr?.toString?.() || "";
    if (stderr) {
      console.log(`    firebase functions:list failed: ${stderr.split("\n")[0]}`);
    }
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return findEtsyWebhookUrl(parsed);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function runOAuthFlow(
  apiKey: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = generateRandomString(32);
  const challenge = generateCodeChallenge(verifier);
  const state = generateRandomString(16);

  const authUrl =
    "https://www.etsy.com/oauth/connect?" +
    new URLSearchParams({
      response_type: "code",
      client_id: apiKey,
      redirect_uri: redirectUri,
      scope: ETSY_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  console.log("Authorize this app in your browser:");
  console.log(`  ${authUrl}`);
  try {
    execSync(`open "${authUrl}"`, { stdio: "ignore" });
  } catch {
    // Non-macOS or no `open`; the user opens manually.
  }

  console.log();
  console.log(
    `After authorising, the browser will redirect to ${redirectUri}/?code=...&state=...`,
  );
  console.log("It will likely fail to load (that's fine). Copy the 'code'");
  console.log("query parameter from the URL bar.");
  const code = await prompt("Paste code: ");
  if (!code) throw new Error("Empty code");

  const response = await fetch(
    "https://api.etsy.com/v3/public/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: apiKey,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${await response.text()}`);
  }
  return await response.json();
}

function etsyAuthHeaders(env: Record<string, string>): Record<string, string> {
  // Etsy v3 "confidential" apps require the keystring concatenated with the
  // app's shared secret (separated by a colon) as the x-api-key value.
  // Public apps accept just the keystring.  We support both transparently:
  // if ETSY_KEYSTRING_SHARED_SECRET is set, we append it.
  const apiKey = env.ETSY_KEYSTRING_SHARED_SECRET
    ? `${env.ETSY_API_KEY}:${env.ETSY_KEYSTRING_SHARED_SECRET}`
    : env.ETSY_API_KEY;
  return {
    "x-api-key": apiKey,
    Authorization: `Bearer ${env.ETSY_ACCESS_TOKEN}`,
  };
}

async function discoverShopId(env: Record<string, string>): Promise<string> {
  // Etsy v3 access tokens are formatted as `<user_id>.<token>`.
  const userId = env.ETSY_ACCESS_TOKEN.split(".")[0];
  if (!userId || !/^\d+$/.test(userId)) {
    throw new Error(
      `Could not parse user_id from access token (expected '<user_id>.<token>')`,
    );
  }
  const shopsResp = await fetch(
    `https://openapi.etsy.com/v3/application/users/${userId}/shops`,
    { headers: etsyAuthHeaders(env) },
  );
  if (!shopsResp.ok) {
    throw new Error(
      `users/${userId}/shops failed: ${await shopsResp.text()}`,
    );
  }
  const shops = await shopsResp.json();
  const shopId =
    shops.shop_id ||
    shops.results?.[0]?.shop_id ||
    shops.shops?.[0]?.shop_id;
  if (!shopId) throw new Error("Could not find a shop_id for this user");
  return String(shopId);
}

async function listWebhooks(env: Record<string, string>): Promise<any[]> {
  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${env.ETSY_SHOP_ID}/webhooks`,
    { headers: etsyAuthHeaders(env) },
  );
  if (!resp.ok) {
    throw new Error(`list webhooks failed: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.results || [];
}

async function deleteWebhook(
  env: Record<string, string>,
  webhookId: string | number,
): Promise<void> {
  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${env.ETSY_SHOP_ID}/webhooks/${webhookId}`,
    {
      method: "DELETE",
      headers: etsyAuthHeaders(env),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `delete webhook ${webhookId} failed: ${await resp.text()}`,
    );
  }
}

async function registerWebhook(
  env: Record<string, string>,
  topic: string,
): Promise<{ shared_secret?: string; webhook_id?: string | number }> {
  const resp = await fetch(
    `https://openapi.etsy.com/v3/application/shops/${env.ETSY_SHOP_ID}/webhooks`,
    {
      method: "POST",
      headers: {
        ...etsyAuthHeaders(env),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        topic,
        url: env.ETSY_ORDER_WEBHOOK_URL,
      }),
    },
  );
  if (!resp.ok) {
    throw new Error(`register ${topic} failed: ${await resp.text()}`);
  }
  return await resp.json();
}

async function ensureWebhooks(
  env: Record<string, string>,
  envPath: string,
  dryRun: boolean,
): Promise<string | null> {
  const existing = await listWebhooks(env);
  const existingByTopic = new Map<string, any>(
    existing.map((w) => [w.topic, w]),
  );
  let capturedSecret: string | null = env.ETSY_SHARED_SECRET || null;
  let secretsSeen = new Set<string>();
  if (capturedSecret) secretsSeen.add(capturedSecret);

  for (const topic of DEFAULT_TOPICS) {
    const hook = existingByTopic.get(topic);
    if (hook && hook.url === env.ETSY_ORDER_WEBHOOK_URL) {
      console.log(`    ${topic}: already registered`);
      continue;
    }
    if (hook && hook.url !== env.ETSY_ORDER_WEBHOOK_URL) {
      console.log(
        `    ${topic}: registered with different URL (${hook.url}); replacing`,
      );
      if (!dryRun) await deleteWebhook(env, hook.webhook_id);
    }
    if (dryRun) {
      console.log(
        `    ${topic}: would register against ${env.ETSY_ORDER_WEBHOOK_URL}`,
      );
      continue;
    }
    const result = await registerWebhook(env, topic);
    console.log(`    ${topic}: registered`);
    if (result.shared_secret) {
      capturedSecret = result.shared_secret;
      secretsSeen.add(result.shared_secret);
    }
  }

  if (secretsSeen.size > 1) {
    console.log(
      "    note: Etsy returned distinct shared_secrets per webhook; using the most recent.",
    );
  }

  if (capturedSecret && capturedSecret !== env.ETSY_SHARED_SECRET && !dryRun) {
    updateEnvFile(envPath, { ETSY_SHARED_SECRET: capturedSecret });
  }
  return capturedSecret;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envName = getStringArg(args, "env", "emulator");
  const dryRun = getBooleanArg(args, "dry-run", false);
  const reauth = getBooleanArg(args, "reauth", false);
  const redirectUri = getStringArg(args, "redirect-uri", "https://localhost");
  const envPath = envFilePathFor(envName);

  if (!existsSync(envPath)) {
    console.error(`${envPath} does not exist.  Create it first.`);
    process.exit(1);
  }

  console.log(`Etsy setup — ${envName} (${envPath})`);
  let env = loadEnvFile(envPath);

  if (!env.ETSY_API_KEY) {
    console.error(`ETSY_API_KEY missing from ${envPath}.  Add it first.`);
    process.exit(1);
  }

  // Step 1: OAuth
  console.log("[1/4] OAuth");
  if (env.ETSY_ACCESS_TOKEN && !reauth) {
    console.log("    ETSY_ACCESS_TOKEN already set");
  } else {
    if (dryRun) {
      console.log("    (dry run) would run OAuth flow");
    } else {
      const tokens = await runOAuthFlow(env.ETSY_API_KEY, redirectUri);
      updateEnvFile(envPath, {
        ETSY_ACCESS_TOKEN: tokens.access_token,
        ETSY_REFRESH_TOKEN: tokens.refresh_token,
      });
      env = loadEnvFile(envPath);
      console.log("    ETSY_ACCESS_TOKEN persisted");
    }
  }

  // Step 2: Discover shop id
  console.log("[2/4] Shop id");
  if (env.ETSY_SHOP_ID) {
    console.log(`    ETSY_SHOP_ID = ${env.ETSY_SHOP_ID}`);
  } else if (!env.ETSY_ACCESS_TOKEN) {
    console.log("    (no access token; cannot discover)");
  } else if (dryRun) {
    console.log("    (dry run) would call /users/<user_id>/shops");
  } else {
    try {
      const shopId = await discoverShopId(env);
      updateEnvFile(envPath, { ETSY_SHOP_ID: shopId });
      env = loadEnvFile(envPath);
      console.log(`    ETSY_SHOP_ID = ${shopId}`);
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      if (msg.includes("Shared secret is required")) {
        console.error(
          "    Etsy rejected the call because your app is a *confidential* client.",
        );
        console.error(
          `    Add ETSY_KEYSTRING_SHARED_SECRET to ${envPath} — it's the`,
        );
        console.error(
          "    'Shared Secret' shown next to your keystring on the Etsy",
        );
        console.error("    developer-portal API page — then re-run.");
        process.exit(1);
      }
      throw err;
    }
  }

  // Step 3: Webhook URL
  console.log("[3/4] Webhook URL");
  const cliWebhookUrl = getStringArg(args, "webhook-url", "");
  if (cliWebhookUrl && cliWebhookUrl !== env.ETSY_ORDER_WEBHOOK_URL) {
    if (!dryRun) {
      updateEnvFile(envPath, { ETSY_ORDER_WEBHOOK_URL: cliWebhookUrl });
      env = loadEnvFile(envPath);
    }
    console.log(`    ETSY_ORDER_WEBHOOK_URL = ${cliWebhookUrl}`);
  } else if (env.ETSY_ORDER_WEBHOOK_URL) {
    console.log(`    ETSY_ORDER_WEBHOOK_URL = ${env.ETSY_ORDER_WEBHOOK_URL}`);
  } else {
    console.log(
      "    ETSY_ORDER_WEBHOOK_URL not set; looking up via firebase functions:list…",
    );
    const discovered = dryRun ? null : discoverWebhookUrlFromFirebase(envName);
    if (discovered) {
      if (!dryRun) {
        updateEnvFile(envPath, { ETSY_ORDER_WEBHOOK_URL: discovered });
        env = loadEnvFile(envPath);
      }
      console.log(`    ETSY_ORDER_WEBHOOK_URL = ${discovered}`);
    } else {
      const projectId = resolveProjectId(envName) || "<project-id>";
      console.log(
        "    Could not find etsyOrderWebhook in firebase functions:list output.",
      );
      console.log("    The function may not be deployed yet.  Deploy first:");
      console.log(`        npm run deploy:functions:${envName}`);
      console.log("    or inspect the listing manually:");
      console.log(`        firebase functions:list --project ${projectId}`);
      if (dryRun) {
        console.log("    (dry run) would prompt for URL");
      } else {
        const url = await prompt(
          "Paste webhook URL now, or Enter to skip: ",
        );
        if (url) {
          updateEnvFile(envPath, { ETSY_ORDER_WEBHOOK_URL: url });
          env = loadEnvFile(envPath);
          console.log(`    ETSY_ORDER_WEBHOOK_URL = ${url}`);
        } else {
          console.log("    Skipped.  Re-run this script after deploy.");
          return;
        }
      }
    }
  }

  // Step 4: Register webhooks
  console.log("[4/4] Webhooks");
  if (
    !env.ETSY_SHOP_ID ||
    !env.ETSY_ACCESS_TOKEN ||
    !env.ETSY_ORDER_WEBHOOK_URL
  ) {
    console.log("    skipped (missing shop id, access token, or webhook URL)");
    return;
  }
  await ensureWebhooks(env, envPath, dryRun);

  console.log();
  console.log(`Done.  ${envPath} now has the Etsy values for ${envName}.`);
  if (envName !== "emulator" && envName !== "local") {
    console.log(`Run \`npm run deploy:functions:${envName}\` to ship the`);
    console.log("shared secret to the deployed function.");
  }
}

main().catch((e) => {
  console.error(String(e?.message || e));
  process.exit(1);
});
