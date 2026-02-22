# TESTS_REMEDIATION

## Purpose

This document captures the current testing state on:

- `main` (worktree at `/tmp/admin2-main`, commit `a517293`)
- current branch `listing-creation` (current remediation state at commit `332c7e4`)

It also defines a concrete plan to make tests reliable, organized, and enforced so branches cannot drift into a broken state.

Initial audit date: 2026-02-21.

## Status Update (2026-02-21)

The initial branch failures documented in this file were remediated on `listing-creation`.

Current `listing-creation` status:

1. `npm run check`: **PASS**
- `0 errors` (non-blocking warnings remain)

2. `npm run lint`: **PASS**
- Prettier check is green after formatting normalization.

3. `npm run test`: **PASS**
- `Test Files 21 passed | 3 skipped`
- `Tests 136 passed | 8 skipped`

4. Hooks and enforcement: **ACTIVE**
- Husky is auto-installed on clone/install via `prepare: husky`.
- `.husky/pre-commit` now enforces:
  - `npm run ci`
  - `npm run check`
  - `bun run test` (fallback `npm run test`)
- Hook script is in Husky v9+ format (deprecated bootstrap lines removed).

Scope note:
- `main` has not yet been re-audited after these branch remediations.
- E2E and live test reliability work is still open.

## Status Update (2026-02-22)

Live E2E photo-flow work was substantially improved and re-baselined.

Current live-photo status on `listing-creation`:

1. `npm run test:live:e2e` (photo flows + auth setup): **PASS observed**
- Recent run completed green (`3 passed` including `auth.setup`).
- Baselines were regenerated after real rendering-flow fixes.

2. `e2e/live/001-photo-processing`: **PASS observed, mildly flaky**
- Uses deterministic Drive fixture selection for the `001` flow (explicit preferred Drive file ID for fixture 8103 JPEG).
- We have observed successful passing runs.
- Flakiness remains possible in live network / image-processing timing, so this is not yet suitable as a required local gate.

3. `e2e/live/002-journey`: **PASS observed**
- Screenshot baseline updated to match current deterministic rendering behavior.

4. Live Playwright retries: **DISABLED**
- `playwright.live.config.ts` now sets `retries: 0`.
- This aligns with the project policy that E2E tests should fail loudly rather than self-heal via retries.

5. Remaining gap
- Live photo-flow tests are functional and much more deterministic, but still depend on external services and local secrets/setup.
- They remain outside pre-commit enforcement.

## Test Surface Inventory

### `main` scripts

- `check`
- `lint`
- `test`
- `test:e2e`, `test:e2e:simple`, `test:e2e:local-images`, `test:e2e:ui`, `test:e2e:headed`, `test:e2e:report`
- `precommit` (only `check-no-wait-for-timeout` helper)
- Husky pre-commit existed, but clone-local installation/enforcement was inconsistent

### `listing-creation` scripts

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

## Current State: `listing-creation` (updated)

### Observed command results

1. `npm run check`: **PASS**
- `0 errors` (warnings only)

2. `npm run lint`: **PASS**
- All matched files use Prettier style.

3. `npm run test`: **PASS**
- `Test Files 21 passed | 3 skipped`
- `Tests 136 passed | 8 skipped`

4. `npm run test:bun`: **not a required gate**
- Pre-commit uses Bun when available, but falls back to npm tests.

5. `npm run test:live:doctor`: **FAIL**
- Missing required live env vars:
  `E2E_GOOGLE_CLIENT_ID`, `E2E_GOOGLE_CLIENT_SECRET`, `E2E_GOOGLE_DRIVE_REFRESH_TOKEN`, `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`, `E2E_GOOGLE_DRIVE_FOLDER_ID`.

6. `npm run test:live:contracts`: **FAIL**
- Same `$lib/*` resolution failures as Vitest run.

7. `npm run test:e2e:simple`: **still unstable**
- Not yet part of pre-commit gate.
- Prior audit runs showed broad failures and environment instability.

### What is implemented and working on this branch

- Type checks are green.
- Formatting checks are green.
- Default Vitest suite is green.
- Husky pre-commit gate is active and auto-installed via `prepare`.
- Additional live-test tooling is present (doctor/contracts/workflows/e2e scripts).

### What is implemented but still failing/open on this branch

- Live tests fail without env/secrets (expected in local default setup).
- E2E remains unstable and is not yet promoted to required gate.
- Tiered scripts (`test:fast`, `test:smoke`, `test:full`) are not yet implemented.

## Root Causes

1. **No tiered enforcement model**
- Fast, deterministic checks and slow/environmental checks are mixed in developer expectations.

2. **Hook installation drift (now mitigated)**
- Hooks were not guaranteed active in every clone.
- Mitigated via `prepare: husky` and verified active pre-commit enforcement.

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

Progress:
- Active branch now satisfies this baseline.
- `main` baseline bring-up is still pending.

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
5. For live E2E, prefer deterministic fixture IDs (Drive file IDs) over human filenames when the runtime source is Drive.

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
- pre-commit -> `npm run test:fast` (currently equivalent is enforced via `ci + check + test`)
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
