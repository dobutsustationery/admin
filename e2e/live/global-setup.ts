import * as fs from "fs";
import * as path from "path";
import { loadLiveEnvLocal } from "./load-live-env";

async function globalSetup() {
  loadLiveEnvLocal();
  console.log("🌍 [Live Setup] Resetting emulator fixtures...");

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
  const projectCandidates = [
    process.env.VITE_FIREBASE_LOCAL_PROJECT_ID,
    process.env.VITE_FIREBASE_PROJECT_ID,
    "dobutsu-admin",
    "demo-test-project",
  ].filter(Boolean) as string[];
  const projects = Array.from(new Set(projectCandidates));

  let clearedAnyProject = false;
  for (const projectId of projects) {
    const clearUrl = `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
    const clearResponse = await fetch(clearUrl, { method: "DELETE" });
    if (!clearResponse.ok) {
      console.warn(
        `⚠️ [Live Setup] Firestore clear failed for project ${projectId}: ${clearResponse.status} ${clearResponse.statusText}`,
      );
      continue;
    }
    clearedAnyProject = true;
    console.log(
      `✅ [Live Setup] Firestore emulator cleared for project ${projectId}`,
    );
  }

  if (!clearedAnyProject) {
    throw new Error(
      "Failed to clear Firestore emulator for any configured project ID.",
    );
  }

  // Per-test sandbox lifecycle is handled in e2e/live/fixtures.ts.
  // Ensure stale file from older runs does not trigger teardown cleanup.
  const envFile = path.resolve(process.cwd(), "e2e/live/.env.live.json");
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
  }
}

export default globalSetup;
