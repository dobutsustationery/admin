---
name: blast-radius
description: Use this skill when assessing reducer or replay behavior changes in this repo, especially when the user asks for blast radius, before/after replay diffs, production-backup impact, or reproducible analysis across commits.
---

# Blast Radius

Use the checked-in blast-radius script for replay comparisons. Do not hand-roll a one-off replay diff unless the script cannot express the question.

## Standard Workflow

1. Choose a backup explicitly, usually the latest production backup requested by the user.
2. Choose a baseline commit and a head commit.
3. Run:

```bash
npm run blast-radius -- compare --base <baseline-ref> --head <head-ref> --backup <backup-dir-or-firestore-export.json> --name <short-run-name>
```

The script creates per-commit worktrees under `.blastradius/worktrees/<commit-sha>`, runs `bun install` and `svelte-kit sync` inside each worktree through `nix develop` when a flake is present, replays the backup, and writes artifacts under `.blastradius/runs/<name>/`. Use `--frozen-install` only when you specifically need lockfile-strict dependency installation for commits known to support it.

## Outputs

Review these files before reporting:

- `metadata.json`: commits, backup, replay counts, errors, and artifact paths.
- `<base>.json` and `<head>.json`: full materialized inventory replay state.
- `report.md`: normalized inventory replay diff.

## Reporting Rules

- State the exact backup path, baseline ref, head ref, and run directory.
- Report replay errors before interpreting business differences.
- Distinguish visible item count changes, cost ledger changes, history changes, and top-level state changes.
- If testing uncommitted code, use `--head working-tree` and say clearly that the head side is exploratory rather than a reproducible commit.
- Keep generated `.blastradius/` artifacts out of git.
