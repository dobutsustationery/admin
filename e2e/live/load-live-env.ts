import fs from "fs";
import path from "path";

const LIVE_ENV_PATH = path.resolve(process.cwd(), ".env.live.local");

export function loadLiveEnvLocal(): void {
  if (!fs.existsSync(LIVE_ENV_PATH)) return;

  const lines = fs.readFileSync(LIVE_ENV_PATH, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key.startsWith("E2E_")) continue;
    process.env[key] = value;
  }
}
