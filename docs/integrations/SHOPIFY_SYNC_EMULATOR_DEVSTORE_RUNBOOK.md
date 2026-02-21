# Shopify Sync Runbook (Emulators + Dev Store)

> Status: Practical setup and testing guide for the current event-sourced `shopify_sync` architecture.

This runbook is step-by-step and intended to be followed in order.

## 1. What You Are Testing

The browser writes append-only events to Firestore collection `shopify_sync`.

Event sequence for one request:
1. `sync_requested` (from UI or CLI)
2. `sync_claimed` (function/worker claims request)
3. `sync_api_call` (one event per Shopify API call)
4. `sync_completed` OR `sync_partial_failed` OR `sync_failed`

You monitor derived request status at `/sync-status`.

## 2. Prerequisites

1. Shopify Partner account + Development Store.
2. A custom app in that dev store with scopes:
   - `read_products`
   - `write_products`
   - `read_inventory`
   - `write_inventory`
   - `read_locations` (required to resolve location ID before inventory sync)
3. Shopify app credentials from your dev store app:
   - `Client ID`
   - `Client secret`
   - (optional) static Admin API token if your app provides one
4. Firebase CLI installed and logged in.
5. Local repo dependencies installed (`npm install`).
6. Functions dependencies installed:
   ```bash
   npm run functions:install
   ```

## 3. Configure Shopify Credentials via Local `.env` Files

Create these gitignored files in the repo root:

1. `./.env.emulator` (used for local emulators)
2. `./.env.staging` (used for staging deploy)
3. `./.env.production` (used for production deploy)

Minimum required values for each file:

```bash
SHOPIFY_STORE_URL=your-store.myshopify.com
SHOPIFY_API_VERSION=2026-01

# Option A: Static token (if available)
# SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxx

# Option B: Dev Dashboard credentials (recommended)
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxx
SHOPIFY_CLIENT_SECRET=xxxxxxxxxxxxxxxx
```

How this is used:
- `npm run emulators` automatically prepares `functions/.env` from `./.env.emulator`.
- `npm run deploy:staging` automatically prepares `functions/.env` from `./.env.staging`.
- `npm run deploy:production` automatically prepares `functions/.env` from `./.env.production`.

No manual shell `export` is required.

Where to find values in Shopify:
1. Open your store admin (for example `DobutsuDev`) -> `Apps and sales channels`.
2. Open your app (created in Dev Dashboard).
3. Copy `Client ID` and `Client secret`.
4. Store domain is your `SHOPIFY_STORE_URL` (for example `dobutsudev.myshopify.com`).

## 4. Start Local Stack (App + Firestore/Auth/Functions Emulators)

Open terminal A:
```bash
npm run emulators
```

Open terminal B:
```bash
npm run dev:local
```

Expected local endpoints:
- App: `http://localhost:5173`
- Emulator UI: `http://localhost:4000`
- Functions emulator: `http://localhost:5001`

## 5. Prepare Test Listing Data

You need a listing in live mode with at least one linked variant.

Options:
1. Use existing local emulator data.
2. Import data to emulator via your existing data tools.
3. Create/edit listing in UI until `listing-detail` live mode exists:
   - `/listing-detail?mode=live&handle=<handle>`

Checklist before syncing:
- Listing has handle, title, body, and at least one image (recommended).
- At least one associated variant exists.
- Each variant has `janCode` and `subtype` (SKU derives from both).

## 6. Test Browser-Triggered Sync

1. Open listing detail in live mode.
2. Click **Sync This Listing**.
3. Open `/sync-status`.
4. Verify request lifecycle appears for the same `requestId`:
   - `sync_requested`
   - `sync_claimed`
   - multiple `sync_api_call`
   - final completion event (`sync_completed` or failure variant)
5. In Shopify dev store admin, verify:
   - product exists/updated by handle
   - variant inventory levels match expected available qty

## 7. Inspect Raw Events (Audit)

Use emulator UI (`http://localhost:4000`):
1. Firestore -> `shopify_sync`
2. Filter by `requestId`
3. Confirm append-only event chain with server `timestamp` ordering.

Also inspect `broadcast` collection for mirrored `shopify_api_log` entries.

## 8. Test CLI Queue + Worker (Same Event Stream)

Queue request into `shopify_sync`:
```bash
npm run shopify:sync:request -- --firestore-env emulator --handle <handle>
```

Execute queued requests via worker:
```bash
npm run shopify:sync:worker -- --firestore-env emulator --limit 10
```

Or execute one event doc ID:
```bash
npm run shopify:sync:worker -- --firestore-env emulator --request-doc-id <eventDocId>
```

Verify outcomes in `/sync-status` (same as browser flow).

## 9. Common Failure Modes

1. Function never claims request:
   - Check functions emulator running.
   - Confirm event has `eventType == sync_requested`.

2. Immediate `sync_failed` with missing env vars:
   - Ensure `./.env.emulator` has `SHOPIFY_STORE_URL` and one credential mode:
     - `SHOPIFY_ACCESS_TOKEN`, or
     - `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`.
   - Re-run `npm run emulators` (it regenerates `functions/.env` automatically).

3. `sync_api_call` failures on product upsert:
   - Validate token scopes in Shopify custom app.
   - Confirm store URL/token are for the same dev store.

4. Inventory sync failures:
   - Check product variants include SKUs from your request payload.
   - Check Shopify location exists and inventory item IDs are returned.

5. No requests in `/sync-status`:
   - Ensure signed-in user can write Firestore.
   - Confirm app is connected to local env (`npm run dev:local`).

## 10. Promote to Staging/Production

1. Put Shopify creds in `./.env.staging` or `./.env.production`.
2. Deploy:
   ```bash
   npm run deploy:staging
   # or
   npm run deploy:production
   ```
3. Perform one canary listing sync from UI.
4. Validate `/sync-status` and Shopify admin before broader use.

## 11. Acceptance Checklist

- [ ] Browser click creates `sync_requested` event.
- [ ] Processor creates `sync_claimed` event.
- [ ] API calls are logged as `sync_api_call` events.
- [ ] Final event (`sync_completed` / `sync_partial_failed` / `sync_failed`) exists.
- [ ] `/sync-status` derived state matches raw event sequence.
- [ ] Shopify dev store reflects expected product/inventory state.
