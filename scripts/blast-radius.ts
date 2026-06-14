import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { spawnSync } from "child_process";

type CaptureTarget = {
  ref: string;
  label: string;
  worktreePath: string;
  commitSha: string | null;
  isCurrentWorktree: boolean;
};

const repoRoot = realpathSync(resolve(import.meta.dir, ".."));
const blastRoot = join(repoRoot, ".blastradius");
const worktreeRoot = join(blastRoot, "worktrees");
const runRoot = join(blastRoot, "runs");

function usage(): never {
  console.error(
    [
      "Usage:",
      "  bun scripts/blast-radius.ts capture --ref <commit-ish|working-tree> --backup <backup-dir|firestore-export.json> [--out-dir <dir>] [--label <name>] [--skip-install] [--force-install] [--frozen-install]",
      "  bun scripts/blast-radius.ts compare --base <commit-ish> --head <commit-ish|working-tree> --backup <backup-dir|firestore-export.json> [--name <run-name>] [--skip-install] [--force-install] [--frozen-install]",
      "",
      "Outputs are written under .blastradius/runs/<name>/ by default.",
    ].join("\n"),
  );
  process.exit(1);
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; quiet?: boolean } = {},
): string {
  if (!options.quiet) {
    console.error(`$ ${[command, ...args].join(" ")}`);
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf-8",
    stdio: options.quiet ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(
      `Command failed (${result.status}): ${[command, ...args].join(" ")}${stderr}`,
    );
  }
  return String(result.stdout || "").trim();
}

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function resolveBackup(input: string): string {
  const path = isAbsolute(input) ? input : resolve(repoRoot, input);
  if (!existsSync(path)) throw new Error(`Backup path does not exist: ${path}`);
  return path;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

function resolveCommit(ref: string): string {
  return run("git", ["rev-parse", `${ref}^{commit}`], { quiet: true });
}

function isGitWorktree(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function ensureWorktree(ref: string): CaptureTarget {
  if (ref === "working-tree") {
    return {
      ref,
      label: "working-tree",
      worktreePath: repoRoot,
      commitSha: null,
      isCurrentWorktree: true,
    };
  }

  const commitSha = resolveCommit(ref);
  const label = shortSha(commitSha);
  const worktreePath = join(worktreeRoot, commitSha);
  mkdirSync(worktreeRoot, { recursive: true });

  if (!existsSync(worktreePath)) {
    run("git", ["worktree", "add", "--detach", worktreePath, commitSha]);
  } else if (!isGitWorktree(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree`);
  } else {
    const existingSha = run("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
      quiet: true,
    });
    if (existingSha !== commitSha) {
      throw new Error(
        `${worktreePath} is checked out at ${existingSha}, expected ${commitSha}`,
      );
    }
  }

  return { ref, label, worktreePath, commitSha, isCurrentWorktree: false };
}

function shellCommandForWorktree(
  worktreePath: string,
  command: string,
): [string, string[]] {
  if (existsSync(join(worktreePath, "flake.nix"))) {
    return ["nix", ["develop", worktreePath, "-c", "sh", "-lc", command]];
  }
  return ["sh", ["-lc", command]];
}

function prepareWorktree(
  target: CaptureTarget,
  options: { forceInstall: boolean; frozenInstall: boolean },
) {
  const hasNodeModules = existsSync(join(target.worktreePath, "node_modules"));
  if (options.forceInstall || !hasNodeModules) {
    const installCommand = options.frozenInstall
      ? "bun install --frozen-lockfile"
      : "bun install";
    const [command, args] = shellCommandForWorktree(
      target.worktreePath,
      installCommand,
    );
    run(command, args, { cwd: target.worktreePath });
  }

  const [command, args] = shellCommandForWorktree(
    target.worktreePath,
    "bun run svelte-kit sync",
  );
  run(command, args, { cwd: target.worktreePath });
}

function captureState(options: {
  target: CaptureTarget;
  backupPath: string;
  outPath: string;
  skipInstall: boolean;
  forceInstall: boolean;
  frozenInstall: boolean;
}) {
  mkdirSync(dirname(options.outPath), { recursive: true });
  if (!options.skipInstall) {
    prepareWorktree(options.target, {
      forceInstall: options.forceInstall,
      frozenInstall: options.frozenInstall,
    });
  }

  const relScript = "scripts/inventory-replay-dump.ts";
  run(
    "bun",
    [
      relScript,
      "capture",
      "--backup",
      options.backupPath,
      "--out",
      options.outPath,
    ],
    { cwd: options.target.worktreePath },
  );
}

function readCaptureMeta(path: string) {
  const json = JSON.parse(readFileSync(path, "utf-8"));
  return {
    actionCount: json?.meta?.actionCount,
    replayErrors: json?.meta?.replayErrors,
    replayMs: json?.meta?.replayMs,
    totals: json?.totals,
  };
}

function writeRunMetadata(path: string, data: Record<string, unknown>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

async function capture(args: string[]) {
  const ref = argValue(args, "--ref");
  const backup = argValue(args, "--backup");
  if (!ref || !backup) usage();

  const backupPath = resolveBackup(backup);
  const target = ensureWorktree(ref);
  const outDir =
    argValue(args, "--out-dir") ||
    join(
      runRoot,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${target.label}`,
    );
  const label = sanitizeName(argValue(args, "--label") || target.label);
  const outPath = join(resolve(repoRoot, outDir), `${label}.json`);
  const skipInstall = hasFlag(args, "--skip-install");
  const forceInstall = hasFlag(args, "--force-install");
  const frozenInstall = hasFlag(args, "--frozen-install");

  captureState({
    target,
    backupPath,
    outPath,
    skipInstall,
    forceInstall,
    frozenInstall,
  });
  writeRunMetadata(join(resolve(repoRoot, outDir), "metadata.json"), {
    command: "capture",
    backupPath,
    target,
    outPath,
    skipInstall,
    forceInstall,
    frozenInstall,
    meta: readCaptureMeta(outPath),
  });
  console.error(`Capture written to ${outPath}`);
}

async function compare(args: string[]) {
  const baseRef = argValue(args, "--base");
  const headRef = argValue(args, "--head");
  const backup = argValue(args, "--backup");
  if (!baseRef || !headRef || !backup) usage();

  const backupPath = resolveBackup(backup);
  const base = ensureWorktree(baseRef);
  const head = ensureWorktree(headRef);
  const runName = sanitizeName(
    argValue(args, "--name") ||
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${base.label}-to-${head.label}`,
  );
  const outDir = join(runRoot, runName);
  const basePath = join(outDir, `${base.label}.json`);
  const headPath = join(outDir, `${head.label}.json`);
  const reportPath = join(outDir, "report.md");
  const skipInstall = hasFlag(args, "--skip-install");
  const forceInstall = hasFlag(args, "--force-install");
  const frozenInstall = hasFlag(args, "--frozen-install");

  captureState({
    target: base,
    backupPath,
    outPath: basePath,
    skipInstall,
    forceInstall,
    frozenInstall,
  });
  captureState({
    target: head,
    backupPath,
    outPath: headPath,
    skipInstall,
    forceInstall,
    frozenInstall,
  });

  run(
    "bun",
    [
      "scripts/inventory-replay-dump.ts",
      "diff",
      basePath,
      headPath,
      "--out",
      reportPath,
    ],
    { cwd: repoRoot },
  );

  writeRunMetadata(join(outDir, "metadata.json"), {
    command: "compare",
    backupPath,
    base,
    head,
    basePath,
    headPath,
    reportPath,
    skipInstall,
    forceInstall,
    frozenInstall,
    relativeReportPath: relative(repoRoot, reportPath),
    baseMeta: readCaptureMeta(basePath),
    headMeta: readCaptureMeta(headPath),
  });

  console.error(`Blast-radius report written to ${reportPath}`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "capture") {
    await capture(args);
  } else if (command === "compare") {
    await compare(args);
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
