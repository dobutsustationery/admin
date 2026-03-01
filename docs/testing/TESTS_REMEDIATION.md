# TESTS_REMEDIATION

## Testing Summary (2026-02-23)

This is the current testing surface and status on the active branch.

### Enforcement gates (current)

1. Commit gate (`.husky/pre-commit`): `npm run ci`, `npm run check`, `bun run test` (fallback `npm run test`)
2. Push gate (`.husky/pre-push`): `npm run test:live:doctor`, `npm run test:live:contracts`, `npm run test:live:workflows`, `npm run test:live:e2e`, `npm run test:e2e`

This keeps local commit latency reasonable while still enforcing non-live E2E and live test suites before push.
Live suites intentionally run first as a temporary workaround so known live flake(s) fail faster and do not waste time running the full non-live E2E suite first.
The push gate runs on isolated ports (`+10000` offset from normal local defaults) so it does not attach to or interfere with a developer's active dev server/emulators.
The pre-push hook now hardens emulator startup by:

- using isolated emulator ports via `firebase.prepush.json`
- auto-killing stray Java emulator listeners on those isolated ports
- failing fast if the emulator process exits before readiness
- checking both Firestore and Auth emulator readiness (not Firestore only)

### Default required / expected-green local suites

1. `npm run check` (Svelte/TS checks): **PASS** (expected to pass)
2. `npm run lint` (Prettier check): **PASS** (expected to pass)
3. `npm run test` (Vitest unit/integration): **PASS** (expected to pass)

- Default Vitest now excludes `tests/live/**`; live Vitest suites are opt-in via `VITEST_INCLUDE_LIVE=1`.

4. `npm run test:e2e` (non-live Playwright via emulators + local fixtures): **PASS** (expected to pass)

- Now excludes `e2e/live/**` and `e2e/experiments/**` by default.
- Current non-live Playwright surface is **19 tests in 19 files**.
- `playwright.nonlive.config.ts` forces a fresh `vite preview` server (`reuseExistingServer: false`) to avoid stale-preview blank-page failures.
- Local image URL rewriting now uses **relative `/test-images/...` paths** (not absolute `http://localhost:PORT/...`) so screenshots are stable across normal local runs (`4173`) and isolated pre-push runs (`14173`).
- `download-test-images.js` now merges and sorts `e2e/test-images/url-mapping.json` deterministically and avoids rewriting the file when unchanged (reduces churn).

### Push-gated / environment-dependent suites

1. `npm run test:live:doctor`: **PASS** only when live Google fixture env/tokens are configured
2. `npm run test:live:contracts`: **Expected PASS with valid live env/tokens**
3. `npm run test:live:workflows`: **Expected PASS with valid live env/tokens**
4. `npm run test:live:e2e`: **PASS observed**, but remains external-service dependent and somewhat flaky; now enforced at push time (not commit time)

- Known current flaky area: `e2e/live/001-photo-processing` (historically around `006-remove-bg-completed` thumbnail render timing)
- Mitigation in place: visible image decode + render-frame stabilization before live photo-processing screenshots

### Intentionally not in default `npm run test:e2e`

1. `e2e/live/**`: excluded (live/external dependencies)
2. `e2e/experiments/**`: excluded (debug/experimental specs, previously reported as skipped)

### Are any tests that should be passing currently not passing?

No known failures in the expected-green local suites (`check`, `lint`, `test`, `test:e2e`) after the current E2E remediations and snapshot refreshes.
Recent push succeeded after:

- regenerating affected non-live snapshots (`002`, `090`, plus prior `015` refresh/stabilization work)
- fixing pre-push emulator startup/port conflicts
- removing port-sensitive local-image URL text from snapshots by switching rewritten URLs to relative paths

Remaining caveats:

- Live suites still depend on secrets/tokens and external services.
- Pushes now require live env/tokens to be configured locally because live suites are part of `.husky/pre-push`.
- Live `001` remains mildly flaky even after render/decode stabilization; push ordering currently optimizes for fast failure rather than eliminating that flake.
- `test:e2e:ui`, `test:e2e:headed`, and `test:e2e:report` are tooling/runner convenience commands rather than pass/fail gate suites.

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
- `.husky/pre-push` now enforces:
  - `npm run test:e2e` (non-live Playwright)
  - `npm run test:live:doctor`
  - `npm run test:live:contracts`
  - `npm run test:live:workflows`
  - `npm run test:live:e2e`
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

## Status Update (2026-02-22, later)

Non-live Playwright E2E was re-baselined and brought back to green after UI drift and harness drift.

Current non-live E2E status on `listing-creation`:

1. `npm run test:e2e`: **PASS** (expected local gate)

- Runs via `playwright.nonlive.config.ts`
- Excludes `e2e/live/**` and `e2e/experiments/**`
- Current discovered test count: **19 tests**

2. Snapshot refresh completed for current UI

- Regenerated snapshots for affected specs including:
  `009-itemhistory`, `013-order-import`, `014-photos`, `015-listings-creation`, and `090-audit-log`

3. Harness hardening applied

- `playwright.nonlive.config.ts` now sets `webServer.reuseExistingServer = false`
- This fixed intermittent blank-page failures caused by stale reused `vite preview` servers in local runs

## Status Update (2026-02-23)

Push-gate reliability was improved and port-specific snapshot failures were remediated.

1. `.husky/pre-push`: **hardened**

- Runs on isolated ports and now starts/keeps emulator stack reliably for push-time suites.
- Detects and kills stray Java listeners on isolated emulator ports (`18080`, `19099`) before startup.
- Fails fast when emulator startup exits early instead of waiting the full readiness timeout.
- Current push ordering is **live-first, non-live E2E last** to reduce retry cost while live `001` flake remains open.

2. `e2e/run-tests.sh`: **hardened**

- Emulator readiness now checks **both Firestore and Auth**.
- Detects partial-emulator state (e.g., Firestore up / Auth down), kills stale Java listeners on configured ports, and fails fast if startup exits.

3. Local image URL rewrite: **port-independent**

- `e2e/helpers/load-test-data.js` and `e2e/helpers/load-test-data-with-local-images.js` now rewrite to relative `/test-images/...` paths.
- This removes screenshot diffs caused purely by `localhost:4173` vs `localhost:14173` appearing in visible UI text.

4. `e2e/test-images/url-mapping.json` churn: **reduced**

- `e2e/helpers/download-test-images.js` now merges against the existing mapping and writes deterministically (sorted keys) only when content changes.

5. Snapshot remediations completed

- `015-listings-creation` screenshots were regenerated and stabilized for zero-pixel tolerance (no masking) using deterministic fixture data and explicit sync/image/render stabilization.
- Port-sensitive snapshot baselines were refreshed for affected specs including `002-csv` and `090-audit-log`.

6. Live `001` photo-processing flake: **mitigated, not eliminated**

- Added visible-image decode + render-frame waits before screenshot capture in `e2e/live/001-photo-processing/001-photo-processing.spec.ts`.
- Pushes can still fail on live flake; live-first ordering is the current pragmatic mitigation.

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

## Revised Next Steps (Current Priority Order)

The branch is materially healthier than the original remediation state. The next plan should prioritize targeted reliability work and push-flow ergonomics over broad framework redesign.

### Priority 1: Eliminate remaining live `001` flake

Target: `e2e/live/001-photo-processing` (`006-remove-bg-completed` and related image-heavy captures)

1. Capture and categorize the remaining diff location(s) for `006-remove-bg-completed` across multiple failures.
2. Add a stricter screenshot readiness helper for live image-heavy pages:

- visible images loaded
- `decode()` completed
- 2+ paint frames
- no pending operation UI indicators
- optional DOM-layout stability poll (same thumbnail dimensions/positions across consecutive frames)

3. Re-run `test:live:e2e` multiple times to confirm the fix before changing policy.

Definition of done:

- `e2e/live/001-photo-processing` passes repeated local runs without snapshot drift.

### Priority 2: Make push-gate behavior explicit and maintainable

1. Document the current push behavior (live-first ordering, isolated ports, auto-kill of stray Java emulators) in a runbook section.
2. Add a short pre-push summary line to print which stage failed (`live doctor`, `live contracts`, `live workflows`, `live e2e`, `non-live e2e`) for faster triage.
3. Consider an env toggle to bypass live suites for emergency pushes (only if team policy allows; default should remain enforced).

Definition of done:

- Push failures are immediately attributable to a specific stage with minimal log scrolling.

### Priority 3: Finish local image fixture hygiene

1. Confirm `e2e/test-images/url-mapping.json` no longer changes on no-op `npm run test:e2e` runs.
2. If churn remains, lock down any remaining non-deterministic ordering in image extraction/download scripts.
3. Add a short note in `e2e/LOCAL_IMAGES_SETUP.md` that rewritten test-data image URLs are relative (`/test-images/...`) by design to support isolated-port runs.

Definition of done:

- `url-mapping.json` remains unchanged on repeated no-op local E2E runs.

### Priority 4: Reassess test-tier scripting after reliability work

The earlier proposal (`test:fast` / `test:smoke` / `test:full`) is still directionally good, but it is not the immediate bottleneck anymore.
Do this after the live `001` flake is materially reduced.

1. Keep current enforced hooks while reliability is still improving.
2. Revisit whether push-time live enforcement remains the right tradeoff once flake rate is known.
3. If needed, split:

- `test:push:required` (deterministic)
- `test:live:gate` (explicit, still enforced in CI or optional locally)

Definition of done:

- Current push success is repeatable enough for active development, and remaining failures are primarily tracked live-test flake(s) rather than broad harness breakage.

## Expected End State (100% Working Tests)

- `main` is green for `check`, `lint`, `test`, and `test:smoke`.
- Every commit passes deterministic fast checks locally.
- Every push passes smoke checks.
- Full suite and live suite are enforced in CI with clear separation.
- No branch can be merged with red tests.
