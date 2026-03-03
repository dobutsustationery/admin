# Sync Functions

This folder contains Firebase Functions for sync queue processing (scoped by domain/action).

## Functions

- `shopifySyncRequest`
  - Trigger: Firestore `request_shopify_sync/{requestId}` create
  - Processes Shopify sync requests and writes lifecycle events to `sync`
- `photosTransferRequest`
  - Trigger: Firestore `request_photos_transfer/{requestId}` create
  - Processes transfer requests and writes lifecycle events to `sync`
- `photosTransformRequest`
  - Trigger: Firestore `request_photos_transform/{requestId}` create
  - Processes transform requests and writes lifecycle events to `sync`
- `photosSecretResponse`
  - Trigger: Firestore `sync/{requestId}` create
  - Handles client response event `photos/image_transfer_secret_provided`
  - Resumes original transfer/transform workflow

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
