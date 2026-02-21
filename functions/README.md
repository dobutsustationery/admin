# Shopify Sync Function

This folder contains Firebase Functions for Shopify sync processing.

## Function

- `syncShopifyRequest`
  - Trigger: Firestore `shopify_sync/{requestId}` create
  - Processes only events where `eventType === sync_requested`
  - Emits append-only follow-up events in `shopify_sync`:
    - `sync_claimed`
    - `sync_api_call`
    - `sync_completed` / `sync_partial_failed` / `sync_failed`
  - Upserts Shopify product by handle
  - Syncs inventory levels for request variants
  - Writes API logs to `broadcast` as `shopify_api_log`

## Shared Logic

Shared modules used by both cloud function and CLI worker:

- `functions/shared/shopify-sync-core.cjs` (Shopify API primitives)
- `functions/shared/shopify-sync-worker.cjs` (request claim/process orchestration)

## Required Runtime Environment Variables

- `SHOPIFY_STORE_URL` (e.g. `your-store.myshopify.com`)
- `SHOPIFY_ACCESS_TOKEN` (`shpat_...`)
- `SHOPIFY_API_VERSION` (default `2024-01` if omitted)

## Local

```bash
cd functions
npm install
cd ..
firebase emulators:start
```

## Deploy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```
