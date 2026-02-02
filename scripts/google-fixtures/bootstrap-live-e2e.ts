import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import http from "http";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";

const ENV_OUTPUT_PATH = path.resolve(process.cwd(), ".env.live.local");
const ADC_PATH = path.resolve(
  process.env.HOME || "",
  ".config/gcloud/application_default_credentials.json",
);

const REDIRECT_PORT = 8787;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;
const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const PHOTOS_SCOPES = [
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
];

type Args = {
  projectId: string;
  projectName: string;
  createProject: boolean;
  addFirebase: boolean;
  skipGcloud: boolean;
  skipApiEnablement: boolean;
  skipAdcLogin: boolean;
  driveFolderName: string;
  photosAlbumTitle: string;
};

type AdcCreds = {
  client_id: string;
  client_secret: string;
  refresh_token: string;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (key: string) =>
    args.find((a) => a.startsWith(`${key}=`))?.split("=")[1] || "";

  return {
    projectId: get("--project-id"),
    projectName: get("--project-name"),
    createProject: !args.includes("--no-create-project"),
    addFirebase: args.includes("--add-firebase"),
    skipGcloud: args.includes("--skip-gcloud"),
    skipApiEnablement: args.includes("--skip-api-enablement"),
    skipAdcLogin: args.includes("--skip-adc-login"),
    driveFolderName: get("--drive-folder-name") || "DobutsuE2E",
    photosAlbumTitle: get("--photos-album-title") || "DobutsuE2EFixtures",
  };
}

function sh(command: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execSync(command, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (err: any) {
    if (opts.allowFail) return "";
    const stderr = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(`${command}\n${stderr}`);
  }
}

function ensureCommandExists(name: string) {
  const result = sh(`command -v ${name}`, { allowFail: true });
  if (!result) throw new Error(`Missing required command: ${name}`);
}

function normalizeProjectId(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-");
  return base.slice(0, 30) || `dobutsu-e2e-${Date.now().toString().slice(-8)}`;
}

function ensureProject(projectId: string, projectName: string, createProject: boolean) {
  const existing = sh(
    `gcloud projects describe ${projectId} --format='value(projectId)'`,
    { allowFail: true },
  );
  if (existing === projectId) {
    console.log(`✅ Using existing project: ${projectId}`);
    return;
  }
  if (!createProject) {
    throw new Error(`Project ${projectId} does not exist and --no-create-project was used.`);
  }
  const name = projectName || projectId;
  console.log(`🆕 Creating project ${projectId} (${name})...`);
  sh(`gcloud projects create ${projectId} --name='${name.replace(/'/g, "\\'")}'`);
}

function maybeAddFirebase(projectId: string, addFirebase: boolean) {
  if (!addFirebase) return;
  const firebaseCmd = sh("command -v firebase", { allowFail: true });
  if (!firebaseCmd) {
    console.warn("⚠️ firebase CLI not found; skipping Firebase project initialization.");
    return;
  }
  console.log(`🔥 Adding Firebase services to ${projectId}...`);
  sh(`firebase projects:addfirebase ${projectId}`, { allowFail: true });
}

function enableApis(projectId: string) {
  const services = [
    "drive.googleapis.com",
    "photoslibrary.googleapis.com",
    "photospicker.googleapis.com",
    "picker.googleapis.com",
  ];
  console.log(`🔌 Enabling APIs for ${projectId}...`);
  sh(`gcloud config set project ${projectId}`);
  sh(`gcloud services enable ${services.join(" ")}`);
}

function ensureAdcLogin(skipAdcLogin: boolean) {
  if (skipAdcLogin && fs.existsSync(ADC_PATH)) return;
  if (skipAdcLogin && !fs.existsSync(ADC_PATH)) {
    throw new Error(`ADC credentials not found at ${ADC_PATH} and --skip-adc-login was set.`);
  }
  console.log("🔐 Running gcloud ADC login for Drive/Photos scopes...");
  console.log("   (Uses cloud-platform scope for project automation only)");
  sh(
    `gcloud auth application-default login --scopes='${CLOUD_PLATFORM_SCOPE}'`,
  );
}

function readAdcCreds(): AdcCreds {
  if (!fs.existsSync(ADC_PATH)) {
    throw new Error(`ADC credentials file not found: ${ADC_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(ADC_PATH, "utf-8")) as Partial<AdcCreds>;
  if (!raw.client_id || !raw.client_secret || !raw.refresh_token) {
    throw new Error("ADC file missing client_id/client_secret/refresh_token.");
  }
  return {
    client_id: raw.client_id,
    client_secret: raw.client_secret,
    refresh_token: raw.refresh_token,
  };
}

async function getRefreshToken(
  clientId: string,
  clientSecret: string,
  scopes: string[],
  label: string,
): Promise<string> {
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
  const refreshToken = tokenResponse.tokens.refresh_token;
  if (!refreshToken) {
    throw new Error(`No refresh token returned for ${label}. Ensure consent is granted with prompt=consent.`);
  }
  return refreshToken;
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

async function createPhotosAlbum(
  clientId: string,
  clientSecret: string,
  photosRefreshToken: string,
  title: string,
): Promise<string> {
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

function writeEnvFile(values: Record<string, string>) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_OUTPUT_PATH, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs();
  const rl = readline.createInterface({ input, output });
  try {
    console.log("=== Live E2E Bootstrap ===");
    console.log("Creating project/resources and writing .env.live.local.");

    if (!args.skipGcloud) {
      ensureCommandExists("gcloud");
    }

    const projectId = normalizeProjectId(
      args.projectId || `dobutsu-e2e-${Date.now().toString().slice(-8)}`,
    );
    const projectName = args.projectName || projectId;

    if (!args.skipGcloud) {
      ensureProject(projectId, projectName, args.createProject);
      if (!args.skipApiEnablement) enableApis(projectId);
      maybeAddFirebase(projectId, args.addFirebase);
      ensureAdcLogin(args.skipAdcLogin);
    }

    // Validate ADC exists (required for gcloud-managed bootstrap context).
    readAdcCreds();
    const defaultClientId = process.env.E2E_GOOGLE_CLIENT_ID || "";
    const defaultClientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET || "";

    const useProvided = defaultClientId && defaultClientSecret;
    if (!useProvided) {
      console.log("\n⚠️  A project-specific OAuth Web Client is required for Drive/Photos scopes.");
      console.log("Create one in Google Auth Platform and add redirect URI:");
      console.log(`   ${REDIRECT_URI}`);
      console.log("You can set E2E_GOOGLE_CLIENT_ID/E2E_GOOGLE_CLIENT_SECRET or paste below.\n");
    }

    const clientId = useProvided
      ? defaultClientId
      : (await rl.question("OAuth client id: ")).trim();
    const clientSecret = useProvided
      ? defaultClientSecret
      : (await rl.question("OAuth client secret: ")).trim();

    if (!clientId || !clientSecret) {
      throw new Error("OAuth client id/secret are required.");
    }

    const driveRefreshToken = await getRefreshToken(
      clientId,
      clientSecret,
      DRIVE_SCOPES,
      "Drive",
    );
    const photosRefreshToken = await getRefreshToken(
      clientId,
      clientSecret,
      PHOTOS_SCOPES,
      "Photos",
    );

    const driveFolderId = await createOrFindDriveFolder(
      clientId,
      clientSecret,
      driveRefreshToken,
      args.driveFolderName,
    );
    const photosAlbumId = await createPhotosAlbum(
      clientId,
      clientSecret,
      photosRefreshToken,
      args.photosAlbumTitle,
    );

    writeEnvFile({
      E2E_GOOGLE_CLIENT_ID: clientId,
      E2E_GOOGLE_CLIENT_SECRET: clientSecret,
      E2E_GOOGLE_DRIVE_REFRESH_TOKEN: driveRefreshToken,
      E2E_GOOGLE_PHOTOS_REFRESH_TOKEN: photosRefreshToken,
      E2E_GOOGLE_DRIVE_FOLDER_ID: driveFolderId,
      E2E_GOOGLE_PHOTOS_ALBUM_ID: photosAlbumId,
      E2E_GOOGLE_PROJECT_ID: projectId,
    });

    console.log(`\n✅ Bootstrap complete. Wrote ${ENV_OUTPUT_PATH}`);
    console.log("Next steps:");
    console.log("  1) set -a && source .env.live.local && set +a");
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
