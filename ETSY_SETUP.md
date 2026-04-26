# Etsy Integration Setup Guide

This guide explains how to set up the Etsy Order Sync integration for the `admin2` project.

## 1. Get Etsy API Credentials

1.  Go to the [Etsy Developer Portal](https://www.etsy.com/developers/register).
2.  Create a new App (or use an existing one).
3.  You will receive:
    *   **API Key (Keystring)**: Used as `ETSY_API_KEY`.
    *   **Shared Secret**: Used as `ETSY_SHARED_SECRET`.
4.  Find your **Shop ID**. You can find this in your shop's URL or via the API.

## 2. Configure Environment Variables

Update your `.env.production` (or `.env.local` for testing) with the following:

```bash
ETSY_SHOP_ID=your_shop_id
ETSY_API_KEY=your_api_key_keystring
ETSY_SHARED_SECRET=your_shared_secret
ETSY_ORDER_WEBHOOK_URL=https://your-firebase-region-project.cloudfunctions.net/etsyOrderWebhook
```

## 3. Perform OAuth 2.0 Flow

Etsy v3 uses OAuth 2.0 with PKCE. Use the provided setup tool to get an access token.

### Step 1: Generate Authorization URL
Run the following command (substituting `production` for your target environment):

```bash
bun scripts/etsy-setup.ts --env production --token
```

This will output a **CODE VERIFIER** and an **Authorization URL**. 
1.  **Save the Code Verifier** immediately.
2.  Open the URL in your browser and authorize the app.
3.  After authorizing, you will be redirected (e.g., to `https://localhost`). 
4.  Copy the `code` parameter from the address bar.

### Step 2: Exchange Code for Token
Run the command again with the code and your saved verifier:

```bash
bun scripts/etsy-setup.ts --env production --exchange "YOUR_CODE" --verifier "YOUR_VERIFIER"
```

If successful, it will output an `Access Token`. Add it to your `.env` file:
```bash
ETSY_ACCESS_TOKEN=your_newly_acquired_token
```

## 4. Register Webhooks

Once you have the credentials and token set up in your environment, register the webhooks:

```bash
bun scripts/etsy-setup.ts --env production --apply
```

## 5. Testing the Setup

### Unit Tests
Run the Etsy-specific unit tests to verify the reducer logic:
```bash
npm test tests/unit/etsy-history.test.ts
```

### Manual Verification
1.  Place a test order on Etsy.
2.  Check the Firebase Functions logs for `etsyOrderWebhook`.
3.  Check the `broadcast` collection in Firestore for an `etsy_order_created` action.
4.  Open the `admin2` UI and verify that the JAN's `shipped` quantity has updated and a history entry exists.

### Reconciliation Poller
The poller runs every 15 minutes. You can trigger it manually via the Firebase Console or by waiting for the schedule to hit. It will catch up on any missed webhooks using the `ETSY_ACCESS_TOKEN`.
