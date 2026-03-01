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
  "https://www.googleapis.com/auth/photoslibrary",
  "https://www.googleapis.com/auth/photoslibrary.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
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

type OAuthClientJsonDefaults = {
  clientId: string;
  clientSecret: string;
  projectId: string;
  redirectUris: string[];
};

function parseDotEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const result: Record<string, string> = {};
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  });
  return result;
}

function loadLocalEnvDefaults(): Record<string, string> {
  const emulatorEnv = parseDotEnvFile(
    path.resolve(process.cwd(), ".env.emulator"),
  );
  const localEnv = parseDotEnvFile(path.resolve(process.cwd(), ".env.local"));
  const liveLocalEnv = parseDotEnvFile(
    path.resolve(process.cwd(), ".env.live.local"),
  );
  return {
    ...emulatorEnv,
    ...localEnv,
    ...liveLocalEnv,
  };
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const get = (key: string) => {
    const match = args.find((a) => a.startsWith(`${key}=`));
    if (!match) return "";
    const equalsIndex = match.indexOf("=");
    return equalsIndex === -1 ? "" : match.slice(equalsIndex + 1);
  };

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

function listDobutsuE2EProjects(): string[] {
  const output = sh(
    "gcloud projects list --filter='projectId~^dobutsu-e2e' --format='value(projectId)'",
    { allowFail: true },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function deleteProject(projectId: string) {
  console.log(`🗑️ Deleting project: ${projectId}`);
  sh(`gcloud projects delete ${projectId} --quiet`);
}

function isYes(answer: string): boolean {
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

function getProjectNumber(projectId: string): string {
  return sh(
    `gcloud projects describe ${projectId} --format='value(projectNumber)'`,
  );
}

function getClientProjectNumber(clientId: string): string {
  return clientId.split("-")[0] || "";
}

function printProjectConsoleLinks(projectId: string) {
  console.log("Open these pages for the correct project:");
  console.log(
    `  - OAuth Clients: https://console.cloud.google.com/auth/clients?project=${projectId}`,
  );
  console.log(
    `  - OAuth Branding/Consent: https://console.cloud.google.com/auth/branding?project=${projectId}`,
  );
  console.log(
    `  - Photos Library API: https://console.cloud.google.com/apis/library/photoslibrary.googleapis.com?project=${projectId}`,
  );
  console.log(
    `  - Photo Picker API: https://console.cloud.google.com/apis/library/photospicker.googleapis.com?project=${projectId}`,
  );
  console.log(
    `  - Drive API: https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${projectId}`,
  );
}

function ensureProject(
  projectId: string,
  projectName: string,
  createProject: boolean,
) {
  const existing = sh(
    `gcloud projects describe ${projectId} --format='value(projectId)'`,
    { allowFail: true },
  );
  if (existing === projectId) {
    console.log(`✅ Using existing project: ${projectId}`);
    return;
  }
  if (!createProject) {
    throw new Error(
      `Project ${projectId} does not exist and --no-create-project was used.`,
    );
  }
  const name = projectName || projectId;
  console.log(`🆕 Creating project ${projectId} (${name})...`);
  sh(
    `gcloud projects create ${projectId} --name='${name.replace(/'/g, "\\'")}'`,
  );
}

function maybeAddFirebase(projectId: string, addFirebase: boolean) {
  if (!addFirebase) return;
  const firebaseCmd = sh("command -v firebase", { allowFail: true });
  if (!firebaseCmd) {
    console.warn(
      "⚠️ firebase CLI not found; skipping Firebase project initialization.",
    );
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
    throw new Error(
      `ADC credentials not found at ${ADC_PATH} and --skip-adc-login was set.`,
    );
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
  const raw = JSON.parse(
    fs.readFileSync(ADC_PATH, "utf-8"),
  ) as Partial<AdcCreds>;
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
    throw new Error(
      `No refresh token returned for ${label}. Ensure consent is granted with prompt=consent.`,
    );
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
  const existing = await drive.files.list({
    q: query,
    fields: "files(id,name)",
    pageSize: 1,
  });
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

async function countAlbumItemsViaSearch(
  accessToken: string,
  albumId: string,
): Promise<number> {
  let count = 0;
  let nextPageToken = "";
  while (true) {
    const response = await fetch(
      "https://photoslibrary.googleapis.com/v1/mediaItems:search",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          albumId,
          pageSize: 100,
          ...(nextPageToken ? { pageToken: nextPageToken } : {}),
        }),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Failed to read album ${albumId}: ${response.status} ${text}`,
      );
    }
    const payload = (await response.json()) as {
      mediaItems?: Array<{ id?: string }>;
      nextPageToken?: string;
    };
    count += (payload.mediaItems || []).length;
    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }
  return count;
}

async function listAllAlbums(
  accessToken: string,
): Promise<Array<{ id?: string; title?: string; mediaItemsCount?: string }>> {
  const albums: Array<{
    id?: string;
    title?: string;
    mediaItemsCount?: string;
  }> = [];
  let nextPageToken = "";
  while (true) {
    const query = new URLSearchParams({
      pageSize: "50",
      ...(nextPageToken ? { pageToken: nextPageToken } : {}),
    });
    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/albums?${query.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Photos album list failed: ${response.status} ${text}`);
    }
    const payload = (await response.json()) as {
      albums?: Array<{ id?: string; title?: string; mediaItemsCount?: string }>;
      nextPageToken?: string;
    };
    albums.push(...(payload.albums || []));
    if (!payload.nextPageToken) break;
    nextPageToken = payload.nextPageToken;
  }
  return albums;
}

async function createOrFindPhotosAlbum(
  clientId: string,
  clientSecret: string,
  photosRefreshToken: string,
  title: string,
): Promise<string> {
  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: photosRefreshToken });
  const tokenRes = await auth.getAccessToken();
  if (!tokenRes.token) throw new Error("Failed to obtain photos access token.");
  const accessToken = tokenRes.token;

  const albums = await listAllAlbums(accessToken);
  const titleMatches = albums.filter((a) => a.title === title && a.id);
  if (titleMatches.length > 0) {
    const ranked = await Promise.all(
      titleMatches.map(async (album) => ({
        id: album.id as string,
        visibleCount: await countAlbumItemsViaSearch(
          accessToken,
          album.id as string,
        ),
      })),
    );
    ranked.sort((a, b) => b.visibleCount - a.visibleCount);
    const best = ranked[0];
    console.log(
      `♻️ Reusing existing Photos album "${title}" (${best.id}) with ${best.visibleCount} visible item(s).`,
    );
    return best.id;
  }

  const response = await fetch(
    "https://photoslibrary.googleapis.com/v1/albums",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ album: { title } }),
    },
  );

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

function loadOAuthClientJsonDefaults(
  inputPath: string,
): OAuthClientJsonDefaults {
  const resolvedPath = path.resolve(process.cwd(), inputPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`OAuth client JSON file not found: ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch (err: any) {
    throw new Error(
      `Failed to parse OAuth client JSON: ${resolvedPath}\n${err?.message || err}`,
    );
  }

  const web = (parsed as { web?: unknown }).web as
    | {
        client_id?: string;
        client_secret?: string;
        project_id?: string;
        redirect_uris?: string[];
      }
    | undefined;

  if (!web?.client_id || !web?.client_secret) {
    throw new Error(
      `OAuth client JSON missing web.client_id/web.client_secret: ${resolvedPath}`,
    );
  }

  return {
    clientId: web.client_id,
    clientSecret: web.client_secret,
    projectId: web.project_id || "",
    redirectUris: Array.isArray(web.redirect_uris) ? web.redirect_uris : [],
  };
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

    let projectId = normalizeProjectId(
      args.projectId || `dobutsu-e2e-${Date.now().toString().slice(-8)}`,
    );
    let projectName = args.projectName || projectId;
    let createProject = args.createProject;
    let projectNumber = "";

    if (!args.skipGcloud) {
      if (!args.projectId) {
        const matchingProjects = listDobutsuE2EProjects();

        if (matchingProjects.length > 1) {
          console.log(
            `\n⚠️ Found ${matchingProjects.length} existing dobutsu-e2e projects:`,
          );
          matchingProjects.forEach((id) => console.log(`  - ${id}`));
          const answer = await rl.question(
            "Delete all of these and create one fresh project? [y/N]: ",
          );
          if (!isYes(answer)) {
            throw new Error(
              "Aborting to avoid creating more dobutsu-e2e projects.",
            );
          }
          matchingProjects.forEach(deleteProject);
          projectId = normalizeProjectId(
            `dobutsu-e2e-${Date.now().toString().slice(-8)}`,
          );
          projectName = args.projectName || projectId;
          createProject = true;
        } else if (matchingProjects.length === 1) {
          const existingId = matchingProjects[0];
          const reuseAnswer = await rl.question(
            `\nFound existing dobutsu-e2e project ${existingId}. Reuse it? [Y/n]: `,
          );
          if (reuseAnswer.trim() === "" || isYes(reuseAnswer)) {
            projectId = existingId;
            projectName = args.projectName || existingId;
            createProject = false;
            console.log(`♻️ Reusing existing project: ${projectId}`);
          } else {
            deleteProject(existingId);
            projectId = normalizeProjectId(
              `dobutsu-e2e-${Date.now().toString().slice(-8)}`,
            );
            projectName = args.projectName || projectId;
            createProject = true;
          }
        } else {
          console.log("\nNo existing dobutsu-e2e project found; creating one.");
          projectId = normalizeProjectId(
            `dobutsu-e2e-${Date.now().toString().slice(-8)}`,
          );
          projectName = args.projectName || projectId;
          createProject = true;
        }
      }

      ensureProject(projectId, projectName, createProject);
      if (!args.skipApiEnablement) enableApis(projectId);
      maybeAddFirebase(projectId, args.addFirebase);
      ensureAdcLogin(args.skipAdcLogin);
      projectNumber = getProjectNumber(projectId);
    }

    // Validate ADC exists (required for gcloud-managed bootstrap context).
    readAdcCreds();
    const fileEnv = loadLocalEnvDefaults();
    let defaultClientId =
      process.env.E2E_GOOGLE_CLIENT_ID ||
      fileEnv.E2E_GOOGLE_CLIENT_ID ||
      fileEnv.VITE_GOOGLE_DRIVE_CLIENT_ID ||
      fileEnv.VITE_GOOGLE_PHOTOS_CLIENT_ID ||
      "";
    let defaultClientSecret =
      process.env.E2E_GOOGLE_CLIENT_SECRET ||
      fileEnv.E2E_GOOGLE_CLIENT_SECRET ||
      "";

    let useProvided = defaultClientId && defaultClientSecret;
    if (!useProvided) {
      console.log(
        "\n⚠️  A project-specific OAuth Web Client is required for Drive/Photos scopes.",
      );
      console.log("I looked for defaults in:");
      console.log(
        "  - E2E_GOOGLE_CLIENT_ID / E2E_GOOGLE_CLIENT_SECRET env vars",
      );
      console.log("  - .env.emulator, .env.local, and .env.live.local");
      console.log(
        "  - VITE_GOOGLE_DRIVE_CLIENT_ID / VITE_GOOGLE_PHOTOS_CLIENT_ID in those files",
      );
      console.log("\nTo get the CLIENT SECRET:");
      console.log("  1) Open Google Cloud Console for your project");
      console.log("  2) Go to Google Auth Platform -> Clients");
      console.log(
        "  3) Open (or create) an OAuth Client of type: Web application",
      );
      printProjectConsoleLinks(projectId);
      console.log("  4) Add authorized redirect URI:");
      console.log(`   ${REDIRECT_URI}`);
      console.log("  5) Copy Client ID and Client Secret");
      console.log("  6) Put them in .env.emulator as:");
      console.log("     E2E_GOOGLE_CLIENT_ID=...");
      console.log("     E2E_GOOGLE_CLIENT_SECRET=...");
      console.log("     (or paste a path to client_secret_*.json below)\n");

      const oauthClientJsonPath = (
        await rl.question(
          "OAuth client JSON path (optional, press Enter to skip): ",
        )
      ).trim();
      if (oauthClientJsonPath) {
        const oauthClientJsonDefaults =
          loadOAuthClientJsonDefaults(oauthClientJsonPath);
        console.log(
          `🔑 Loaded OAuth client defaults from JSON: ${path.resolve(process.cwd(), oauthClientJsonPath)}`,
        );
        if (
          oauthClientJsonDefaults.projectId &&
          oauthClientJsonDefaults.projectId !== projectId
        ) {
          printProjectConsoleLinks(projectId);
          throw new Error(
            `OAuth JSON belongs to project ${oauthClientJsonDefaults.projectId}, but bootstrap target is ${projectId}. Use a client JSON downloaded from project ${projectId}.`,
          );
        }
        if (
          oauthClientJsonDefaults.redirectUris.length > 0 &&
          !oauthClientJsonDefaults.redirectUris.includes(REDIRECT_URI)
        ) {
          printProjectConsoleLinks(projectId);
          throw new Error(
            `OAuth JSON redirect URIs do not include ${REDIRECT_URI}. Update the OAuth Web Client in project ${projectId} and re-download the JSON.`,
          );
        }

        defaultClientId = oauthClientJsonDefaults.clientId;
        defaultClientSecret = oauthClientJsonDefaults.clientSecret;
        useProvided = defaultClientId && defaultClientSecret;
      }
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

    if (projectNumber) {
      const clientProjectNumber = getClientProjectNumber(clientId);
      if (clientProjectNumber && clientProjectNumber !== projectNumber) {
        printProjectConsoleLinks(projectId);
        throw new Error(
          `OAuth client appears to belong to a different project. Expected project number ${projectNumber}, but client id prefix was ${clientProjectNumber}. Use a Web OAuth client created in project ${projectId}.`,
        );
      }
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
    const photosAlbumId = await createOrFindPhotosAlbum(
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
