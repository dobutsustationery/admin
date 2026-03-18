import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ENV_PATH = path.resolve(process.cwd(), ".env.live.local");
const BOOTSTRAP_SCRIPT = path.resolve(
  process.cwd(),
  "scripts/google-fixtures/bootstrap-live-e2e.ts",
);

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = parseEnvFile(ENV_PATH);
const projectId =
  process.env.E2E_GOOGLE_PROJECT_ID || fileEnv.E2E_GOOGLE_PROJECT_ID;

if (!projectId) {
  console.error("Missing E2E_GOOGLE_PROJECT_ID.");
  console.error(
    "Set it in .env.live.local (or env) and rerun. If needed, first run: npm run setup:live:e2e",
  );
  process.exit(1);
}

console.log(`Refreshing live Google refresh tokens for project: ${projectId}`);
console.log("This will open OAuth consent twice (Drive and Photos).");

const result = spawnSync(
  "bun",
  [
    BOOTSTRAP_SCRIPT,
    `--project-id=${projectId}`,
    "--no-create-project",
    "--skip-gcloud",
    "--skip-api-enablement",
    "--skip-adc-login",
    "--auto-open-auth-url",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ...fileEnv,
    },
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
