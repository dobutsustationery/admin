#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_PROJECT_ID =
  process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin";
const DEFAULT_HUB = process.env.FIREBASE_EMULATOR_HUB || "127.0.0.1:4400";
const FIREBASE_CONFIG_PATH = resolve(process.cwd(), "firebase.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function getStringArg(args, key, fallback = "") {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function showHelp() {
  console.log(`Restore a Firestore JSON backup into the emulator without replaying old function requests.

Usage:
  npm run emulators:restore-backup -- --input <backup-dir> [options]

Options:
  --input <dir>           Required. Backup directory containing firestore-export.json
  --snapshot-dir <dir>    Optional. Output emulator snapshot directory
  --hub <host:port>       Optional. Emulator hub address (default: ${DEFAULT_HUB})
  --project <id>          Optional. Firebase project id (default: ${DEFAULT_PROJECT_ID})
  --no-restart            Build the emulator snapshot but do not start the full emulator stack
  --help                  Show help
`);
}

function requireInputDir(inputDir) {
  if (!inputDir) {
    throw new Error("Missing required --input <backup-dir>");
  }
  return resolve(process.cwd(), inputDir);
}

function defaultSnapshotDir(inputDir) {
  const name = basename(resolve(process.cwd(), inputDir)).replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  return resolve(process.cwd(), "emulator-restores", name);
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function getConfiguredEmulatorPorts() {
  if (!existsSync(FIREBASE_CONFIG_PATH)) return [];
  const config = readJsonFile(FIREBASE_CONFIG_PATH);
  const emulators = config?.emulators || {};
  return Object.entries(emulators)
    .map(([name, value]) => ({
      name,
      port:
        value && typeof value === "object" && typeof value.port === "number"
          ? value.port
          : null,
    }))
    .filter((entry) => Number.isFinite(entry.port));
}

function isKnownEmulatorCommand(command) {
  return (
    command.includes("cloud-firestore-emulator") ||
    command.includes("firebase emulators:start") ||
    command.includes("firebase-tools") ||
    command.includes("hub-") ||
    command.includes("ui-v1")
  );
}

function findListeningProcess(port) {
  try {
    const output = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"],
      { encoding: "utf8" },
    );
    const pidLine = output
      .split(/\r?\n/)
      .find((line) => line.startsWith("p") && line.length > 1);
    if (!pidLine) return null;
    const pid = Number(pidLine.slice(1));
    if (!Number.isFinite(pid)) return null;
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    }).trim();
    return { pid, command };
  } catch {
    return null;
  }
}

async function waitForPortToClear(port, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!findListeningProcess(port)) return;
    await delay(250);
  }
  throw new Error(`Port ${port} did not clear within ${timeoutMs}ms`);
}

async function stopKnownEmulatorOnPort(port, name) {
  const occupant = findListeningProcess(port);
  if (!occupant) return;
  if (!isKnownEmulatorCommand(occupant.command)) {
    throw new Error(
      `Cannot start emulator stack: port ${port} for ${name} is occupied by non-emulator process pid=${occupant.pid}: ${occupant.command}`,
    );
  }
  console.log(
    `[restore-backup] stopping existing ${name} emulator process on port ${port} pid=${occupant.pid}`,
  );
  process.kill(occupant.pid, "SIGINT");
  await waitForPortToClear(port);
}

async function ensureDefaultPortsAvailable() {
  const configuredPorts = getConfiguredEmulatorPorts();
  for (const entry of configuredPorts) {
    await stopKnownEmulatorOnPort(entry.port, entry.name);
  }
}

function findAvailablePort(startPort) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = net.createServer();
    server.unref();
    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        resolvePromise(findAvailablePort(startPort + 1));
        return;
      }
      rejectPromise(error);
    });
    server.listen(startPort, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : startPort;
      server.close((closeError) => {
        if (closeError) {
          rejectPromise(closeError);
          return;
        }
        resolvePromise(port);
      });
    });
  });
}

function writeTempFirebaseConfig({ firestorePort, hubPort, targetPath }) {
  const baseConfig = existsSync(FIREBASE_CONFIG_PATH)
    ? readJsonFile(FIREBASE_CONFIG_PATH)
    : {};
  const config = {
    ...baseConfig,
    emulators: {
      ...(baseConfig.emulators || {}),
      firestore: {
        host: "127.0.0.1",
        port: firestorePort,
      },
      ui: {
        enabled: false,
      },
      hub: {
        host: "127.0.0.1",
        port: hubPort,
      },
    },
  };
  writeJsonFile(targetPath, config);
}

function prefixStream(stream, prefix, target) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";
    for (const line of lines) {
      target.write(`${prefix}${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffered) {
      target.write(`${prefix}${buffered}\n`);
      buffered = "";
    }
  });
}

function runCommand(command, args, options = {}) {
  const { env, cwd = process.cwd(), prefix = "" } = options;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
    });

    if (child.stdout) {
      prefixStream(child.stdout, prefix, process.stdout);
    }
    if (child.stderr) {
      prefixStream(child.stderr, prefix, process.stderr);
    }

    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

function startCommandAndWaitForReady(command, args, options = {}) {
  const {
    env,
    cwd = process.cwd(),
    readyPattern = /All emulators ready/i,
    prefix = "",
    startupTimeoutMs = 60_000,
  } = options;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["inherit", "pipe", "pipe"],
    });

    let settled = false;
    let ready = false;
    let timeoutId;

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (!child.killed) {
        child.kill("SIGINT");
      }
      rejectPromise(error);
    };

    const onData = (chunk, target) => {
      const text = chunk.toString("utf8");
      target.write(
        text
          .split(/\r?\n/)
          .filter((line, index, arr) => line || index < arr.length - 1)
          .map((line) => `${prefix}${line}`)
          .join("\n") + (text.endsWith("\n") ? "\n" : ""),
      );
      if (!ready && readyPattern.test(text)) {
        ready = true;
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolvePromise(child);
        }
      }
    };

    child.stdout?.on("data", (chunk) => onData(chunk, process.stdout));
    child.stderr?.on("data", (chunk) => onData(chunk, process.stderr));

    child.on("error", finishReject);
    child.on("exit", (code, signal) => {
      if (ready || settled) return;
      finishReject(
        new Error(
          `${command} ${args.join(" ")} exited before ready with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });

    timeoutId = setTimeout(() => {
      finishReject(
        new Error(
          `${command} ${args.join(" ")} did not become ready within ${startupTimeoutMs}ms`,
        ),
      );
    }, startupTimeoutMs);
  });
}

async function shutdownHub(hubAddress, label, allowFailure = false) {
  try {
    const response = await fetch(`http://${hubAddress}/shutdown`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`shutdown returned ${response.status}`);
    }
    console.log(`[restore-backup] ${label}: emulator hub shutdown requested`);
    await delay(1500);
  } catch (error) {
    if (allowFailure) {
      console.log(
        `[restore-backup] ${label}: no running emulator hub at ${hubAddress}`,
      );
      return;
    }
    throw error;
  }
}

async function waitForProcessExit(child, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        console.log(`[restore-backup] ${label}: process exited`);
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(
          `${label} exited unexpectedly with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
    child.on("error", rejectPromise);
  });
}

async function stopProcess(child, label) {
  if (child.exitCode !== null || child.killed) {
    console.log(`[restore-backup] ${label}: process already stopped`);
    return;
  }
  console.log(`[restore-backup] ${label}: sending SIGINT`);
  child.kill("SIGINT");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const inputDir = requireInputDir(getStringArg(args, "input"));
  const snapshotDir = resolve(
    process.cwd(),
    getStringArg(args, "snapshot-dir") || defaultSnapshotDir(inputDir),
  );
  const hubAddress = getStringArg(args, "hub", DEFAULT_HUB);
  const projectId = getStringArg(args, "project", DEFAULT_PROJECT_ID);
  const shouldRestart = !args["no-restart"];
  const tempFirestorePort = await findAvailablePort(8088);
  const tempHubPort = await findAvailablePort(4401);
  const tempConfigPath = resolve(
    process.cwd(),
    ".tmp-restore-emulator-firebase.json",
  );

  console.log(`[restore-backup] input: ${inputDir}`);
  console.log(`[restore-backup] snapshot: ${snapshotDir}`);
  console.log(`[restore-backup] project: ${projectId}`);
  console.log(`[restore-backup] hub: ${hubAddress}`);
  console.log(`[restore-backup] temp firestore port: ${tempFirestorePort}`);
  console.log(`[restore-backup] temp hub port: ${tempHubPort}`);

  if (!existsSync(inputDir)) {
    throw new Error(`Backup directory not found: ${inputDir}`);
  }

  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  writeTempFirebaseConfig({
    firestorePort: tempFirestorePort,
    hubPort: tempHubPort,
    targetPath: tempConfigPath,
  });

  console.log(
    "[restore-backup] shutting down any running emulator stack before restore",
  );
  await shutdownHub(hubAddress, "pre-restore", true);

  console.log(
    "[restore-backup] starting temporary Firestore-only emulator for raw import",
  );
  const tempEmulator = await startCommandAndWaitForReady(
    "firebase",
    [
      "emulators:start",
      "--config",
      tempConfigPath,
      "--only",
      "firestore",
      "--project",
      projectId,
      `--export-on-exit=${snapshotDir}`,
    ],
    {
      prefix: "[temp-firestore] ",
    },
  );

  let tempExitPromise = waitForProcessExit(tempEmulator, "temp-firestore");

  try {
    console.log("[restore-backup] importing backup into temporary Firestore");
    await runCommand(
      "node",
      ["./scripts/transfer-data.js", "--input", inputDir, "--target", "emulator"],
      {
        env: {
          FIREBASE_EMULATOR_PROJECT_ID: projectId,
          FIRESTORE_EMULATOR_HOST: `127.0.0.1:${tempFirestorePort}`,
        },
        prefix: "[transfer-data] ",
      },
    );

    console.log(
      "[restore-backup] exporting imported Firestore state as emulator snapshot",
    );
    await stopProcess(tempEmulator, "temp-firestore");
    await tempExitPromise;
  } catch (error) {
    console.error(
      `[restore-backup] restore failed during temp import: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      await stopProcess(tempEmulator, "temp-firestore-cleanup");
      await tempExitPromise;
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }

  console.log(`[restore-backup] snapshot ready at ${snapshotDir}`);
  rmSync(tempConfigPath, { force: true });

  if (!shouldRestart) {
    console.log(
      `[restore-backup] full emulator restart skipped. Start manually with: firebase emulators:start --import=${snapshotDir}`,
    );
    return;
  }

  console.log("[restore-backup] preparing functions env for local emulator run");
  await runCommand("npm", ["run", "functions:install"], {
    prefix: "[functions:install] ",
  });
  await runCommand("npm", ["run", "env:functions:local"], {
    prefix: "[env:functions:local] ",
  });

  console.log("[restore-backup] ensuring default emulator ports are available");
  await ensureDefaultPortsAvailable();

  console.log(
    `[restore-backup] starting full emulator stack from restored snapshot ${snapshotDir}`,
  );
  await runCommand(
    "firebase",
    ["emulators:start", "--project", projectId, `--import=${snapshotDir}`],
    {
      prefix: "[emulators] ",
    },
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
