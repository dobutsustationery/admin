import { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ENV_OUTPUT_PATH = path.resolve(process.cwd(), ".env.live.local");
const ADC_PATH = path.resolve(
  process.env.HOME || "",
  ".config/gcloud/application_default_credentials.json",
);

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.file"];
const PHOTOS_SCOPES = [
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
];
const ALL_SCOPES = Array.from(new Set([...DRIVE_SCOPES, ...PHOTOS_SCOPES]));

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
  sh(
    `gcloud auth application-default login --scopes='${ALL_SCOPES.join(",")}'`,
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
  console.log("=== Live E2E Bootstrap ===");
  console.log("Creating project/resources and writing .env.live.local using gcloud ADC credentials.");

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

  const adc = readAdcCreds();
  const clientId = process.env.E2E_GOOGLE_CLIENT_ID || adc.client_id;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET || adc.client_secret;
  const refreshToken = adc.refresh_token;

  const driveFolderId = await createOrFindDriveFolder(
    clientId,
    clientSecret,
    refreshToken,
    args.driveFolderName,
  );
  const photosAlbumId = await createPhotosAlbum(
    clientId,
    clientSecret,
    refreshToken,
    args.photosAlbumTitle,
  );

  writeEnvFile({
    E2E_GOOGLE_CLIENT_ID: clientId,
    E2E_GOOGLE_CLIENT_SECRET: clientSecret,
    E2E_GOOGLE_DRIVE_REFRESH_TOKEN: refreshToken,
    E2E_GOOGLE_PHOTOS_REFRESH_TOKEN: refreshToken,
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
}

main().catch((err) => {
  console.error("❌ Bootstrap failed:", err.message || err);
  process.exit(1);
});

