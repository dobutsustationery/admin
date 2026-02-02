import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import http from "http";
import { execSync } from "child_process";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const ENV_OUTPUT_PATH = path.resolve(process.cwd(), ".env.live.local");
const REDIRECT_PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const PHOTOS_SCOPES = [
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    projectId: args.find((a) => a.startsWith("--project-id="))?.split("=")[1] || "",
    skipGcloud: args.includes("--skip-gcloud"),
  };
}

function requireToken(tokens: { access_token?: string | null; refresh_token?: string | null }, label: string): string {
  if (!tokens.refresh_token) {
    throw new Error(`No refresh token returned for ${label}. Re-run and ensure consent prompt is accepted.`);
  }
  return tokens.refresh_token;
}

async function getRefreshToken(clientId: string, clientSecret: string, scopes: string[], label: string): Promise<string> {
  const oauth2Client = new OAuth2Client(clientId, clientSecret, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
  });

  console.log(`\n[${label}] Open this URL and complete consent:\n${authUrl}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url || "", `http://127.0.0.1:${REDIRECT_PORT}`);
        if (url.pathname !== "/oauth2callback") return;
        const incomingCode = url.searchParams.get("code");
        if (!incomingCode) {
          res.writeHead(400);
          res.end("Missing code");
          reject(new Error(`No authorization code received for ${label}.`));
          server.close();
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Authorization received. You can close this tab.");
        resolve(incomingCode);
        server.close();
      } catch (e) {
        reject(e);
        server.close();
      }
    });

    server.listen(REDIRECT_PORT, "127.0.0.1");
  });

  const tokenResponse = await oauth2Client.getToken(code);
  return requireToken(tokenResponse.tokens, label);
}

async function createOrFindDriveFolder(
  clientId: string,
  clientSecret: string,
  driveRefreshToken: string,
  folderName: string,
): Promise<string> {
  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: "v3", auth });

  const query = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
  const existing = await drive.files.list({ q: query, fields: "files(id,name)", pageSize: 1 });
  if (existing.data.files && existing.data.files.length > 0) {
    return existing.data.files[0].id as string;
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"],
    },
    fields: "id",
  });

  return created.data.id as string;
}

async function createPhotosAlbum(clientId: string, clientSecret: string, photosRefreshToken: string, title: string): Promise<string> {
  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: photosRefreshToken });
  const tokenRes = await auth.getAccessToken();
  if (!tokenRes.token) throw new Error("Failed to obtain photos access token.");

  const response = await fetch("https://photoslibrary.googleapis.com/v1/albums", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenRes.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ album: { title } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Photos album creation failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

function maybeEnableApis(projectId: string) {
  if (!projectId) return;
  const services = [
    "drive.googleapis.com",
    "photoslibrary.googleapis.com",
    "photospicker.googleapis.com",
    "picker.googleapis.com",
  ];

  console.log(`\n[Bootstrap] Enabling APIs in project ${projectId}...`);
  execSync(`gcloud config set project ${projectId}`, { stdio: "inherit" });
  execSync(`gcloud services enable ${services.join(" ")}`, { stdio: "inherit" });
}

function writeEnvFile(values: Record<string, string>) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const { projectId, skipGcloud } = parseArgs();
  const rl = readline.createInterface({ input, output });

  try {
    console.log("=== Live E2E Bootstrap ===");
    console.log("This script obtains refresh tokens, provisions root resources, and writes .env.live.local.");

    let effectiveProjectId = projectId;
    if (!effectiveProjectId) {
      effectiveProjectId = (await rl.question("GCP project id (optional, used for API enablement): ")).trim();
    }

    if (!skipGcloud && effectiveProjectId) {
      maybeEnableApis(effectiveProjectId);
    } else if (!effectiveProjectId) {
      console.log("[Bootstrap] Skipping gcloud API enablement (no project id provided).");
    }

    console.log("\nCreate a Web OAuth client in Google Cloud Console with redirect URI:");
    console.log(`  ${REDIRECT_URI}\n`);

    const clientId =
      process.env.E2E_GOOGLE_CLIENT_ID ||
      (await rl.question("OAuth client id: ")).trim();
    const clientSecret =
      process.env.E2E_GOOGLE_CLIENT_SECRET ||
      (await rl.question("OAuth client secret: ")).trim();

    if (!clientId || !clientSecret) {
      throw new Error("Client ID/secret are required.");
    }

    const driveRefreshToken = await getRefreshToken(clientId, clientSecret, DRIVE_SCOPES, "Drive");
    const photosRefreshToken = await getRefreshToken(clientId, clientSecret, PHOTOS_SCOPES, "Photos");

    const driveFolderName = (await rl.question("Drive root folder name [DobutsuE2E]: ")).trim() || "DobutsuE2E";
    const photosAlbumTitle = (await rl.question("Photos album title [DobutsuE2EFixtures]: ")).trim() || "DobutsuE2EFixtures";

    const driveFolderId = await createOrFindDriveFolder(clientId, clientSecret, driveRefreshToken, driveFolderName);
    const photosAlbumId = await createPhotosAlbum(clientId, clientSecret, photosRefreshToken, photosAlbumTitle);

    writeEnvFile({
      E2E_GOOGLE_CLIENT_ID: clientId,
      E2E_GOOGLE_CLIENT_SECRET: clientSecret,
      E2E_GOOGLE_DRIVE_REFRESH_TOKEN: driveRefreshToken,
      E2E_GOOGLE_PHOTOS_REFRESH_TOKEN: photosRefreshToken,
      E2E_GOOGLE_DRIVE_FOLDER_ID: driveFolderId,
      E2E_GOOGLE_PHOTOS_ALBUM_ID: photosAlbumId,
    });

    console.log(`\n✅ Bootstrap complete. Wrote ${ENV_OUTPUT_PATH}`);
    console.log("Next steps:");
    console.log("  1) source .env.live.local");
    console.log("  2) npm run test:live:doctor");
    console.log("  3) npm run fixtures:google:sync");
    console.log("  4) npm run test:live:e2e");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("❌ Bootstrap failed:", err.message || err);
  process.exit(1);
});

