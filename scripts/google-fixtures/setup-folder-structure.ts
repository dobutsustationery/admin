import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import fs from "fs";
import path from "path";

const LIVE_ENV_PATH = path.resolve(process.cwd(), ".env.live.local");

function loadEnv() {
  if (!fs.existsSync(LIVE_ENV_PATH)) {
    console.error(".env.live.local not found");
    process.exit(1);
  }
  const content = fs.readFileSync(LIVE_ENV_PATH, "utf8");
  const lines = content.split("\n");
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function findOrCreateFolder(
  drive: any,
  name: string,
  parentId: string,
  role: string,
): Promise<string> {
  console.log(`🔍 Checking for ${name} (role: ${role})...`);

  // Try finding by role first
  const roleQuery = `'${parentId}' in parents and properties has { key='folder_role' and value='${role}' } and trashed = false`;
  const roleList = await drive.files.list({
    q: roleQuery,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (roleList.data.files?.length) {
    const id = roleList.data.files[0].id;
    console.log(`✅ Found existing ${name} by role: ${id}`);
    return id;
  }

  // Try finding by name
  const nameQuery = `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const nameList = await drive.files.list({
    q: nameQuery,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (nameList.data.files?.length) {
    const id = nameList.data.files[0].id;
    console.log(
      `✅ Found existing ${name} by name: ${id}. Tagging with role...`,
    );
    await drive.files.update({
      fileId: id,
      requestBody: {
        properties: { folder_role: role },
      },
      supportsAllDrives: true,
    });
    return id;
  }

  // Create new
  console.log(`🌱 Creating new folder ${name}...`);
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
      properties: { folder_role: role },
    },
    fields: "id",
    supportsAllDrives: true,
  });
  console.log(`✅ Created ${name}: ${created.data.id}`);
  return created.data.id;
}

async function main() {
  loadEnv();

  const clientId = process.env.E2E_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.E2E_GOOGLE_CLIENT_SECRET;
  const driveRefreshToken = process.env.E2E_GOOGLE_DRIVE_REFRESH_TOKEN;
  const rootId = process.env.E2E_GOOGLE_DRIVE_FOLDER_ID;

  if (!clientId || !clientSecret || !driveRefreshToken || !rootId) {
    console.error("Missing credentials/root folder in .env.live.local");
    process.exit(1);
  }

  const auth = new OAuth2Client(clientId, clientSecret);
  auth.setCredentials({ refresh_token: driveRefreshToken });
  const drive = google.drive({ version: "v3", auth });

  console.log(`=== Setting up folder structure for root ${rootId} ===`);

  const imagesId = await findOrCreateFolder(
    drive,
    "Images",
    rootId,
    "root_images",
  );
  const originalsId = await findOrCreateFolder(
    drive,
    "Originals",
    imagesId,
    "originals",
  );
  const processedId = await findOrCreateFolder(
    drive,
    "Processed",
    imagesId,
    "processed",
  );
  const seedId = await findOrCreateFolder(drive, "Seed", rootId, "seed");

  // Set world-readable permissions on all folders so public URLs work
  const allFolders = [
    { name: "Root", id: rootId },
    { name: "Images", id: imagesId },
    { name: "Originals", id: originalsId },
    { name: "Processed", id: processedId },
    { name: "Seed", id: seedId },
  ];
  for (const folder of allFolders) {
    try {
      await drive.permissions.create({
        fileId: folder.id,
        requestBody: { role: "reader", type: "anyone" },
        supportsAllDrives: true,
      });
      console.log(`🔓 Set public permissions on ${folder.name}: ${folder.id}`);
    } catch (e: any) {
      // Permission may already exist — that's fine
      if (e?.code === 409 || e?.status === 409) {
        console.log(`🔓 ${folder.name} already public: ${folder.id}`);
      } else {
        console.warn(
          `⚠️ Failed to set permissions on ${folder.name}: ${e?.message || e}`,
        );
      }
    }
  }

  console.log("\n✨ Folder structure setup complete!");
  console.log(`Images: ${imagesId}`);
  console.log(`Originals: ${originalsId}`);
  console.log(`Processed: ${processedId}`);
  console.log(`Seed: ${seedId}`);
}

main().catch(console.error);
