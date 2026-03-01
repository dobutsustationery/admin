# Drive + Google Photos End-to-End Testing Design

## 1) Problem Statement

Drive and Google Photos behavior is currently fragile in production flows:

- OAuth state and token handling can drift or expire unexpectedly.
- External image loading is non-deterministic (URL expiry, throttling, permissions, CORS).
- Photo processing (crop/color correction/background removal/upload) lacks stable, automated verification.
- Existing E2E setup intentionally avoids real Google integrations in CI, which limits confidence.

We need automated tests that exercise the real integrations end-to-end without mocking Drive/Photos APIs.

## 2) Goals

1. Test real Google Drive + Google Photos integrations in automation (no API mocking).
2. Cover full workflows: connect auth, fetch media, categorize, process, upload, listing usage.
3. Add deterministic assertions for image loading and processing outputs.
4. Keep tests reproducible and safe in CI and local runs.
5. Preserve current fast emulator-based tests for quick feedback.

## 3) Non-Goals

- Replacing existing emulator-based E2E smoke tests.
- Validating Google’s own API uptime/SLAs.
- Pixel-perfect equality for all transformed images across all environments (we use robust image metrics instead).

## 4) Testing Strategy (Two Lanes)

### Lane A: Fast Local/PR Checks (existing, keep)

- Firebase emulator + local fixture images.
- Purpose: quick regression feedback on app logic/UI.
- Runs on every PR.

### Lane B: Live Integration Suite (new, no mocks)

- Real Google Drive and Google Photos test tenant.
- Purpose: lock down integration correctness and reliability.
- Runs nightly, on-demand, and optionally on integration-labeled PRs.

Both lanes are required: Lane A for speed, Lane B for real-world confidence.

## 5) Test Tenant and Data Isolation

Create a dedicated Google Cloud project and dedicated test account(s):

- `dobutsu-e2e-drive@...` (or Workspace user)
- `dobutsu-e2e-photos@...`

Use dedicated resources:

- Drive root folder: `DobutsuE2E`
- Photos test library/album: `DobutsuE2EFixtures`

Data model:

- **Immutable seed set** (golden inputs; never mutated by tests).
- **Per-run sandbox** folder/album section (`runs/<runId>`), created at test start and deleted after.

This prevents cross-run pollution and keeps test results reproducible.

## 6) Auth Design for Automation (No UI Login Flakes)

Interactive Google login is brittle in headless CI. Instead:

1. Generate long-lived refresh tokens once (manual secure bootstrap).
2. Store refresh tokens in CI secret manager.
3. Before tests, exchange refresh token -> short-lived access token via OAuth token endpoint.
4. Inject app-local token state (`google_drive_access_token`, `google_photos_access_token`) through Playwright `storageState` or `addInitScript`.

This is still real integration (real tokens, real APIs), just non-interactive auth bootstrapping.

## 7) Fixture Management

Add a fixture manifest in repo (example: `e2e/fixtures/google-media-manifest.json`):

- Logical ID (e.g. `JAN_4542804104370_BLUE_01`)
- Source checksum (SHA-256)
- Expected MIME and dimensions
- Expected subtype/photo-group mapping
- Expected processing outcomes (dimension bounds, transparency constraints, perceptual hash tolerances)

Add scripts:

- `scripts/google-fixtures/sync-seed.ts`: ensure seed files exist in Drive/Photos and match checksums.
- `scripts/google-fixtures/create-run-sandbox.ts`: create per-run folder/album and stage files.
- `scripts/google-fixtures/cleanup-run-sandbox.ts`: delete old run artifacts with TTL.
- `scripts/google-fixtures/healthcheck.ts`: verify token scopes + API reachability before test run.

## 8) Live Integration Test Coverage

### 8.1 Unit/Contract Tests (real APIs)

Focus: adapter-level guarantees in `src/lib/google-drive.ts` and `src/lib/google-photos.ts`.

- `isConfigured`, token parsing/expiry behavior with real token payloads.
- Drive list/search/upload/folder creation behavior with real folder.
- Photos picker session/media retrieval contract checks.
- URL durability checks (fetchability immediately after retrieval/upload).

Mark as `@live` and run separately from default `npm test`.

### 8.2 Workflow Integration Tests (Vitest + real services)

Focus: end-to-end logic without browser UI.

- Load media from Drive/Photos.
- Run processing pipeline (crop/color/background removal) on canonical samples.
- Upload processed outputs to Drive.
- Assert output metadata:
  - dimensions in expected range
  - format/content-type
  - alpha-channel presence/absence where expected
  - perceptual hash distance threshold (instead of exact byte match)

### 8.3 Full Browser E2E (Playwright + real services)

User journeys:

1. Connect Drive + Photos and verify connected state.
2. Import/select media, categorize by JAN/subtype.
3. Process images (single + batch), verify visible completion state.
4. Confirm uploaded/returned URLs load in browser (`naturalWidth > 0`).
5. Complete listing creation flow with real media attached.
6. Re-open listing/detail pages and verify persistence.

## 9) Deterministic Assertions for Images

Use layered assertions (strict -> tolerant):

1. Transport: URL responds 200, not 403/429.
2. Decode: browser image element loads; `naturalWidth/naturalHeight > 0`.
3. Metadata: expected MIME + dimension constraints.
4. Content quality:
   - Perceptual hash distance below threshold for deterministic transforms.
   - For background removal, assert alpha pixel ratio within expected band.
5. Ordering/association:
   - Correct variant/gallery image ordering.
   - Correct subtype photo group mapping.

Do not rely only on screenshots for image correctness.

## 10) Specific Edge Cases & Regression Prevention

Critical scenarios derived from recent regressions:

### 10.1 URL Expiry & Refresh

- **Scenario:** Store a Photos Picker URL, wait >60 mins (simulated or real delay), verify app handles 403.
- **Assertion:** App should prefer immediate promotion to a durable Drive URL as the source of truth. If only an expired picker URL exists, the UI should provide a clear actionable fallback (e.g. reselect/reimport) rather than showing a broken image.
- **SecureImage:** Verify `SecureImage` component correctly identifies expired URLs vs. valid ones and sets error state appropriately.

### 10.2 CORS & Canvas Access

- **Scenario:** Load images from Drive (`drive.google.com`) and Photos Picker (`lh3.googleusercontent.com`).
- **Assertion:**
  - Drive images should load visibly (fallback to `<img>` without CORS if needed).
  - Photos Picker images should load visibly.
  - **Color Correction:** Verify processing uses an authenticated `fetch` + `blob`/data URL path for canvas operations. If that path is unavailable, verify the app disables the feature gracefully with clear user feedback instead of crashing.

### 10.3 Subtype Automation

- **Scenario:** Import multiple photos with distinct subtype visual cues (e.g. Blue vs Red).
- **Assertion:**
  - App correctly groups photos into subtypes.
  - Generated proposals map photos to the correct variant `photoGroupKey`.
  - Batch Editor displays the correct thumbnail for each variant row.
  - "Split Inventory" action correctly allocates stock and maintains photo association.

## 11) CI/CD Execution Plan

Add separate jobs:

- `test:e2e` (existing fast lane).
- `test:live:contracts` (real Drive/Photos contract tests).
- `test:live:e2e` (full Playwright live suite).

Recommended schedule:

- PR: fast lane always; live contracts for labeled PRs (`integration-live`).
- Nightly on `main`: full live suite.
- Manual dispatch for release candidates.

Control flakiness:

- Retry only on known transient statuses (429/5xx) with capped exponential backoff.
- Record HAR + console logs + API error payloads on failure.
- Keep tests serial for shared quota-sensitive resources.

## 12) Required Configuration

New env/secret set (examples):

- `E2E_GOOGLE_CLIENT_ID`
- `E2E_GOOGLE_CLIENT_SECRET`
- `E2E_GOOGLE_DRIVE_REFRESH_TOKEN`
- `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`
- `E2E_GOOGLE_DRIVE_FOLDER_ID`
- `E2E_GOOGLE_PHOTOS_ALBUM_ID`

Security rules:

- Never commit tokens or raw OAuth responses.
- Rotate refresh tokens on schedule and incident.
- Restrict test users to least-privilege scopes and isolated folders/albums.

## 13) Observability and Debuggability

On failure, always capture:

- Playwright trace/video/screenshot
- Browser console logs
- Network HAR
- Structured app logs around Drive/Photos operations (request id, operation, status, latency)
- Final fixture manifest snapshot for the run

Add a one-command diagnostic:

- `npm run test:live:doctor` to verify scopes, folder access, album access, quota headroom.

## 14) Rollout Plan

### Phase 1: Foundation

- Add token bootstrap tooling and healthcheck.
- Create seed fixture manifest and sync scripts.
- Add first live contract tests (Drive list/upload + Photos media retrieval).

### Phase 2: Processing Validation

- Add workflow tests for crop/color/background removal with perceptual assertions.
- Add stability guards (retries/backoff/instrumentation).

### Phase 3: Full Live E2E

- Add Playwright live project and full user journey.
- Wire nightly CI and artifacts.
- Define pass/fail SLO (example: 95% pass over 14 days).

## 15) Acceptance Criteria

This design is complete when:

1. A nightly CI run executes real Drive + Photos tests without mocks.
2. Failures identify exact step (auth, fetch, process, upload, render, persistence).
3. Photo processing regressions are caught by automated metric-based assertions.
4. Listing flows using real media are validated end-to-end.
5. Team can run the live suite locally with documented setup and deterministic fixture prep.

## 16) Suggested New Commands

- `npm run test:live:contracts`
- `npm run test:live:workflows`
- `npm run test:live:e2e`
- `npm run test:live:doctor`
- `npm run fixtures:google:sync`
- `npm run fixtures:google:cleanup`
