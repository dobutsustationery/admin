# Shopify Sync Function

This folder contains Firebase Functions for Shopify sync processing.

## Function

- `syncShopifyListingRequest`
  - Trigger: Firestore `broadcast/{actionId}` create
  - Filters for action type `shopify_sync_listing_request`
  - Upserts Shopify product by handle
  - Syncs inventory levels for request variants
  - Writes `shopify_api_log` and `shopify_sync_listing_result` actions

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
