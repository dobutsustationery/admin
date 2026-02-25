import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, loadEnv, searchForWorkspaceRoot } from "vite";

function safeGit(command: string): string {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    return String(pkg?.version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

function buildTimestampIso(): string {
  return new Date().toISOString();
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const gitHash = safeGit("git rev-parse HEAD");
  const gitShortHash = safeGit("git rev-parse --short HEAD");
  const gitStatus = safeGit("git status --short");
  const gitBranch = safeGit("git rev-parse --abbrev-ref HEAD");
  const packageVersion = readPackageVersion();
  const buildTimeIso = buildTimestampIso();

  const versionEnv = {
    VITE_APP_VERSION: env.VITE_APP_VERSION || packageVersion,
    VITE_APP_GIT_HASH: env.VITE_APP_GIT_HASH || gitHash,
    VITE_APP_GIT_SHORT_HASH: env.VITE_APP_GIT_SHORT_HASH || gitShortHash,
    VITE_APP_GIT_BRANCH: env.VITE_APP_GIT_BRANCH || gitBranch,
    VITE_APP_GIT_DIRTY: env.VITE_APP_GIT_DIRTY || (gitStatus ? "true" : "false"),
    VITE_APP_BUILD_TIME_ISO: env.VITE_APP_BUILD_TIME_ISO || buildTimeIso,
    VITE_APP_BUILD_MODE: env.VITE_APP_BUILD_MODE || mode,
  };

  return {
    plugins: [sveltekit()],
    server: {
      fs: {
        allow: [searchForWorkspaceRoot(process.cwd())],
      },
    },
    define: Object.fromEntries(
      Object.entries(versionEnv).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
    optimizeDeps: {
      exclude: ["firebase", "firebase/app", "firebase/auth", "firebase/firestore"],
    },
  };
});
