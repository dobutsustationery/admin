# Sync Functions

This folder contains Firebase Functions for sync queue processing (scoped by domain/action).

## Function

- `syncRequest`
  - Trigger: Firestore `sync/{requestId}` create
  - Dispatches by scoped event type (currently Shopify)
  - Processes Shopify requests where `eventType === shopify/sync_requested`
  - Emits append-only follow-up events in `sync`:
    - `shopify/sync_claimed`
    - `shopify/sync_api_call`
    - `shopify/sync_completed` / `shopify/sync_partial_failed` / `shopify/sync_failed`
  - Upserts Shopify product by handle
  - Syncs inventory levels for request variants
  - Writes API logs to `broadcast` as `shopify_api_log`

## Shared Logic

Shared modules used by both cloud function and CLI worker:

- `functions/shared/shopify-sync-core.cjs` (Shopify API primitives)
- `functions/shared/shopify-sync-worker.cjs` (request claim/process orchestration)

## Required Runtime Environment Variables

- `SHOPIFY_STORE_URL` (e.g. `your-store.myshopify.com`)
- one credential mode:
  - `SHOPIFY_ACCESS_TOKEN` (`shpat_...`), or
  - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_API_VERSION` (default `2026-01` if omitted)

`functions/.env` is read automatically by Firebase emulators/deploy.
In this repo, generate it from root env files via:

- `npm run env:functions:local` (from `./.env.emulator`)
- `npm run env:functions:staging` (from `./.env.staging`)
- `npm run env:functions:production` (from `./.env.production`)

## Local

```bash
npm run functions:install
npm run emulators
```

## Deploy

```bash
npm run deploy:functions:staging
# or
npm run deploy:functions:production
```
