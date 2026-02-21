# TESTS_REMEDIATION

## Purpose

This document captures the current testing state on:

- `main` (worktree at `/tmp/admin2-main`, commit `a517293`)
- current branch `design/listings-creation` (commit `36f4480`)

It also defines a concrete plan to make tests reliable, organized, and enforced so branches cannot drift into a broken state.

Audit date: 2026-02-21.

## Test Surface Inventory

### `main` scripts

- `check`
- `lint`
- `test`
- `test:e2e`, `test:e2e:simple`, `test:e2e:local-images`, `test:e2e:ui`, `test:e2e:headed`, `test:e2e:report`
- `precommit` (only `check-no-wait-for-timeout` helper)
- Husky `.husky/pre-commit` runs `npm run ci`, `npm run check`, `npm test`

### `design/listings-creation` scripts

Everything from `main`, plus:

- `test:bun`
- `test:live:doctor`
- `test:live:contracts`
- `test:live:workflows`
- `test:live:e2e`

## Current State: `main`

### Observed command results

1. `npm run check`: **FAIL**
- Type/package mismatch in `vite.config.ts` plugin types (vite/vitest type trees).
- Additional TypeScript issues in Svelte components.

2. `npm run lint`: **FAIL**
- Prettier check fails (42 files require formatting).

3. `npm run test`: **FAIL**
- `Test Files 1 failed | 9 passed`
- `Tests 2 failed | 118 passed`
- Both failures in `tests/inventory.test.ts` (`rename_subtype` expectations).

4. `npm run test:e2e:simple`: **FAIL / unstable**
- Multiple Playwright spec failures and webserver instability.
- Failures include app availability/preview lifecycle issues (`ERR_CONNECTION_REFUSED` and server startup instability seen during run).

### What is implemented and working on `main`

- Basic Vitest suite exists and mostly passes.
- Playwright harness exists with broad route coverage.
- Pre-commit hook exists.

### What is implemented but failing on `main`

- Type check gating (`npm run check`) is red.
- Formatting gate is red.
- Unit suite is not fully green (2 known failing tests).
- E2E suite is not dependable in current local run.

## Current State: `design/listings-creation`

### Observed command results

1. `npm run check`: **PASS**
- `0 errors, 2 warnings`

2. `npm run lint`: **FAIL**
- Prettier check fails (81 files require formatting).

3. `npm run test`: **FAIL**
- `Test Files 15 failed | 8 passed | 1 skipped`
- `Tests 1 failed | 69 passed | 2 skipped`
- One assertion failure in `tests/unit/shopify-image-conflict.test.ts`.
- Many suite-load failures from unresolved `$lib/*` module imports.

4. `npm run test:bun`: **FAIL**
- Bun suite includes skipped/failing tests in current run.

5. `npm run test:live:doctor`: **FAIL**
- Missing required live env vars:
  `E2E_GOOGLE_CLIENT_ID`, `E2E_GOOGLE_CLIENT_SECRET`, `E2E_GOOGLE_DRIVE_REFRESH_TOKEN`, `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`, `E2E_GOOGLE_DRIVE_FOLDER_ID`.

6. `npm run test:live:contracts`: **FAIL**
- Same `$lib/*` resolution failures as Vitest run.

7. `npm run test:e2e:simple`: **FAIL**
- Prior full run in this audit session: `13 failed | 8 passed | 2 skipped`.
- Failures include screenshot diffs and functional workflow checks (`inventory`, `root`, `csv`, `subtypes`, `itemhistory`, `jancodes`, `order-import`, `photos`, `listings-creation`, `audit-log`, live flows, and repro publish flow).

### What is implemented and working on this branch

- Type checks are currently green.
- A subset of Vitest tests pass.
- A subset of Playwright specs pass.
- Additional live-test tooling is present (doctor/contracts/workflows/e2e scripts).

### What is implemented but failing on this branch

- Formatting gate is red.
- Core Vitest run is severely degraded due to path-resolution issues.
- Bun run is not a stable green signal.
- Live tests fail without env and currently are mixed into developer expectations without clear gating separation.
- E2E suite has significant red count.

## Root Causes

1. **No tiered enforcement model**
- Fast, deterministic checks and slow/environmental checks are mixed in developer expectations.

2. **Hooks do not reflect reliability**
- Husky pre-commit runs `ci`, `check`, `test`, but those commands are not consistently green across branches.

3. **Environment-coupled tests not isolated**
- Live tests fail by default when secrets are absent.

4. **Module-resolution drift**
- Branch test loader failures (`$lib/*`) indicate config/tooling divergence.

5. **Large formatting debt**
- Prettier drift makes lint a constant red signal and undermines trust.

## Remediation Plan to 100% Working Tests

## Phase 0: Stabilize Baseline (must-do first)

1. Make `npm run check`, `npm run lint`, and `npm run test` green on `main`.
2. Fix branch loader/config drift so `$lib/*` imports resolve in all Vitest entry points.
3. Commit a one-time formatting sweep to eliminate Prettier debt.

Definition of done:
- `main` and active branch both pass `check`, `lint`, `test` locally with no manual setup beyond install.

## Phase 1: Define Test Tiers (contract)

Create explicit tiers and scripts:

1. `test:fast` (pre-commit safe, <2 min)
- `check`
- `lint`
- deterministic unit/integration only (no live env, no network)

2. `test:smoke` (pre-push safe)
- selected Playwright smoke specs with stable fixtures/emulators

3. `test:full` (CI required)
- full Playwright suite
- optional live suite behind explicit opt-in and secrets

Definition of done:
- Every test file belongs to exactly one primary tier.

## Phase 2: Determinism and Config Hardening

1. Standardize Vitest alias resolution in a single shared config.
2. Ensure Playwright webServer lifecycle is deterministic (no missing built-node module race).
3. Split live tests by filename/tag and exclude by default from `test` and `test:fast`.
4. Make snapshot/image-based tests deterministic (fixed viewport, fonts, seed data, retries policy).

Definition of done:
- Re-running the same command without code changes yields same pass/fail result.

## Phase 3: Enforcement via Hooks

1. Pre-commit (`.husky/pre-commit`)
- Run `test:fast` only.
- Fail commit on any red result.

2. Pre-push (`.husky/pre-push`)
- Run `test:smoke`.
- Block push on red.

3. Optional targeted mode
- If needed for speed, run impacted test subsets from changed files, but still keep a minimum invariant gate (`check + lint + core unit smoke`).

Definition of done:
- Cannot create a commit without fast suite green.
- Cannot push without smoke suite green.

## Phase 4: CI as Source of Truth

1. Required CI checks on PR:
- `test:fast`
- `test:smoke`
- `test:full` (or matrix split)

2. Nightly/scheduled:
- live contracts/workflows with secrets.

3. Branch protection:
- disallow merge when required checks are red.

Definition of done:
- Broken branch cannot merge; regressions are caught before integration.

## Phase 5: Operational Discipline

1. Add `docs/testing/TESTING_RUNBOOK.md`:
- exact local commands,
- expected env vars,
- which tiers are required for commit/push/merge.

2. Add ownership:
- assign owner for each test tier and flaky test triage SLA.

3. Track reliability metrics:
- pass rate by tier,
- average runtime,
- flake retry rate,
- top failing specs.

Definition of done:
- Teams can quickly identify and fix red tests, and flaky tests are treated as incidents.

## Immediate Implementation Checklist

1. Create scripts:
- `test:fast`
- `test:smoke`
- `test:full`

2. Update Husky:
- pre-commit -> `npm run test:fast`
- pre-push -> `npm run test:smoke`

3. Exclude live tests from default `npm test` unless `LIVE_TESTS=1`.

4. Fix alias/config so Vitest resolves `$lib/*` consistently.

5. Make `main` green first, then rebase/forward-fix active branches.

## Expected End State (100% Working Tests)

- `main` is green for `check`, `lint`, `test`, and `test:smoke`.
- Every commit passes deterministic fast checks locally.
- Every push passes smoke checks.
- Full suite and live suite are enforced in CI with clear separation.
- No branch can be merged with red tests.
