# Photo repair release validation

October 26, 2026 (Toronto). Implements the [reviewed repair flow](../design/photo-import-repair-plan.md); [operator steps](../ops/photo-repair.md) describe using it. Every replacement still requires individual approval.

## Checks

- Full unit suite: 698 passed, one skipped. The subsequently added worker execution test and affected focused suites also pass (17 tests), including original-download routing, actual import completion, MIME type, approval identity, redo, out-of-order results and publication retry.
- Svelte check: zero errors and warnings. Formatting/reducer checks and production build pass.
- Chromium against isolated Auth/Firestore emulators: fresh file upload, candidate creation, redo, reload, explicit approval and persisted Done status pass. Google/Drive HTTP responses are mocked; the browser test performs no live image replacement.
- The repository-wide E2E standards script reports two existing `waitForTimeout` uses in `e2e/016-shopify-sync/016-shopify-cli.spec.ts` and `e2e/helpers/loading-helper.ts`. This change introduces neither pattern.

## Production replay comparison

The normal full export command exceeded Node's JSON string limit while serializing all collections. The existing broadcast capture tool successfully captured every production broadcast instead: 53,797 documents, with no cutoff exclusions.

- Backup: `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2/data-export/photo-repair-before-2026-10-26/all-broadcast.json`.
- Baseline: `149c222fc1fe2e7a6810eec6392ee8357bb56cdc`.
- Head: `working-tree`, an exploratory capture of the implementation before its release commit.
- Run directory: `/Volumes/Macintosh HD/Users/anicolao/projects/antigravity/admin2/.blastradius/runs/photo-repair-production/`.
- Artifacts reviewed: `metadata.json`, `149c222fc1fe.json`, `working-tree.json`, `report.md` and `report.full-state-diff.json`.

Both replays had zero errors. Inventory remains 1,415 items, with no changes to item values, cost ledgers, orders, history, listing options or existing photo state. The only state differences are seven empty repair maps and schema version 28 to 29. Subsequent repair-only refinements are covered by focused tests; they do not change the behavior of historical events.

## Deployment scope

Hosting and the existing `photosTransferRequest`, `photosTransformRequest`, `photosSecretResponse` and `shopifySyncRequest` functions. The repair slice uses existing broadcast/request collections and their existing rules. No historical events or IDs are migrated, and deployment itself does not approve or replace product images.

Production deployment succeeded for Hosting and all four functions. The final Hosting follow-up excludes already approved repair files from later discovery and matches Shopify URLs across rendition/version query parameters. No live replacement has been approved by this release process.

The Firebase CLI also warned that the existing Node.js 20 runtime is scheduled for decommissioning on October 30, 2026. This release retains that runtime; a separate runtime upgrade is needed for subsequent deployments after that date.
