# Amazon SP-API Setup Guide

> Status: Practical setup guide for Phase 1 Amazon catalog probing.
> Scope: read-only Catalog Items lookup by JAN/EAN. No Firestore writes, no listing writes, no order sync.

This guide gets you from no local Amazon credentials to a working command:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626
```

## 1. What We Are Setting Up

Phase 1 uses Amazon Selling Partner API (SP-API) only to read Amazon catalog data for JAN/EAN codes.

The local script:

1. Exchanges an Amazon Login with Amazon (LWA) refresh token for an access token.
2. Calls SP-API Catalog Items `searchCatalogItems`.
3. Prints compact ASIN/title/brand/product type/image summaries.
4. Writes nothing to Firestore, `broadcast`, or Amazon.

The script is:

```sh
scripts/amazon-catalog-probe.ts
```

## 2. Prerequisites

You need:

1. Access to the Amazon seller account.
2. Access to Seller Central for the marketplace you want to inspect.
3. Permission to authorize SP-API applications for that seller account.
4. A private SP-API application or access to create one.
5. Local repo dependencies installed.

Run commands from the repo root:

```sh
cd /Users/anicolao/projects/antigravity/admin2
```

## 3. Choose Marketplace And Region

SP-API has regional endpoints, while marketplace IDs identify the actual marketplace.

For likely Dobutsu European testing:

```sh
AMAZON_SP_API_REGION=eu
```

Common marketplace IDs:

| Marketplace    | ID               |
| -------------- | ---------------- |
| United Kingdom | `A1F83G8C2ARO7P` |
| Germany        | `A1PA6795UKMFR9` |
| France         | `A13V1IB3VIYZZH` |
| Italy          | `APJ6JRA9NG5V4`  |
| Spain          | `A1RKKUPIHCS9HS` |
| Netherlands    | `A1805IZSGTT6HS` |
| Sweden         | `A2NODRKZP88ZB9` |
| Poland         | `A1C3SOZRARQ6R3` |
| Belgium        | `AMEN7PMS3EDWL`  |
| Ireland        | `A28R8C7NBKEWEA` |
| United States  | `ATVPDKIKX0DER`  |
| Canada         | `A2EUQ1WTGCTBG2` |
| Japan          | `A1VC38T7YXB528` |

Set the marketplace you want:

```sh
AMAZON_MARKETPLACE_ID=A1F83G8C2ARO7P
```

## 4. Create Or Identify A Private SP-API Application

Amazon's UI changes, but the required concepts are stable.

In Seller Central:

1. Open **Apps & Services**.
2. Open **Develop Apps** or the SP-API developer console.
3. Create a private application, or open the existing private app for this seller account.
4. Ensure the app has read access needed for catalog/listing inspection.

For Phase 1, the script needs Catalog Items read access. Later phases will also need Listings Items access.

Record:

```sh
AMAZON_LWA_CLIENT_ID=...
AMAZON_LWA_CLIENT_SECRET=...
```

These are Login with Amazon credentials for the SP-API application.

## 5. Self-Authorize The App

For a private seller app, use Amazon SP-API self-authorization.

In Seller Central / Developer Console:

1. Open the private SP-API application.
2. Choose the option to authorize the app for your own seller account.
3. Complete the authorization flow.
4. Copy the refresh token.

Record:

```sh
AMAZON_LWA_REFRESH_TOKEN=...
```

This refresh token is long-lived and sensitive. Do not commit it.

## 6. Create `.env.amazon`

Create a local gitignored file in the repo root:

```sh
touch .env.amazon
```

Put this in `.env.amazon`:

```sh
AMAZON_LWA_CLIENT_ID=your_lwa_client_id
AMAZON_LWA_CLIENT_SECRET=your_lwa_client_secret
AMAZON_LWA_REFRESH_TOKEN=your_lwa_refresh_token
AMAZON_MARKETPLACE_ID=A1F83G8C2ARO7P
AMAZON_SP_API_REGION=eu
```

Optional:

```sh
AMAZON_SP_API_USER_AGENT=DobutsuAdmin/0.1 (Language=TypeScript; Runtime=Bun)
```

Accepted aliases:

```sh
AMAZON_SP_API_CLIENT_ID=...
AMAZON_SP_API_CLIENT_SECRET=...
AMAZON_SP_API_REFRESH_TOKEN=...
AMAZON_SP_API_MARKETPLACE_ID=...
AMAZON_SP_API_ENDPOINT=...
```

## 7. Validate Token Exchange

First verify only the LWA refresh token exchange:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --check-token
```

Expected result:

```text
LWA token ok: type=bearer expiresIn=3600s
SP-API endpoint: https://sellingpartnerapi-eu.amazon.com
Marketplace: A1F83G8C2ARO7P
```

If this fails, fix credentials before testing catalog search.

## 8. Probe A JAN

Run:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626
```

With multiple JANs:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626 --jan 4902778185650
```

Or with a file:

```sh
cat >/tmp/amazon-jans.txt <<'EOF'
4542804151626
4902778185650
EOF

npm run amazon:catalog:probe -- --env-file .env.amazon --jan-file /tmp/amazon-jans.txt
```

To inspect raw response JSON:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626 --json
```

To make the result visible on `/amazon-listings`, persist replayable raw response records into the local emulator `broadcast` collection:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804131499 --seller-listings --persist-broadcast
```

This still does not write to Amazon.

## 9. Interpreting Output

Possible outcomes:

### No Catalog Match

```text
JAN 4542804151626: 0 item(s) returned
  No catalog match.
```

Amazon does not find a catalog item for that JAN in the selected marketplace.

### One Catalog Match

```text
JAN 4542804151626: 1 item(s) returned
  ASIN: B0...
    Title: ...
    Brand: ...
    Product types: ...
```

This means Amazon has a catalog item. It does not prove we have a seller listing or that the item is buyable from our account.

### Multiple Catalog Matches

Multiple ASINs for the same JAN should be treated as ambiguous. The future `/amazon-listings` page should surface this as an exception instead of guessing.

### Authorization Error

Common causes:

- wrong LWA client ID/secret
- refresh token from a different app
- app not authorized for this seller account
- app lacks required role/scope

### Marketplace Error Or Empty Result

Check:

- `AMAZON_MARKETPLACE_ID`
- `AMAZON_SP_API_REGION`
- whether the item exists in that marketplace rather than another Amazon marketplace

## 10. Security Notes

- Do not commit `.env.amazon`.
- Treat `AMAZON_LWA_REFRESH_TOKEN` like a password.
- Do not paste secrets into issue comments, PR comments, or committed docs.
- The Phase 1 script does not write to Amazon or Firestore, but the credentials may later allow writes if the app is granted those roles.

## 11. Current Limitations

Phase 1 does not:

- enumerate seller listings
- prove a listing is buyable
- read seller SKU state
- read or write price/inventory
- create or update Amazon listings
- write replayable Amazon shadow state

Those belong to later phases in:

```text
docs/design/AMAZON_LISTINGS_DELTA_DESIGN.md
```

## 12. Official References

- Amazon SP-API overview: `https://developer.amazonservices.com/`
- Connect to SP-API: `https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api`
- Private app self-authorization: `https://developer-docs.amazon.com/sp-api/docs/self-authorization`
- Catalog Items API: `https://developer-docs.amazon.com/sp-api/reference/catalog-items-v2022-04-01`
- `searchCatalogItems`: `https://developer-docs.amazon.com/sp-api/reference/searchcatalogitems`
- Listings Items API: `https://developer-docs.amazon.com/sp-api/reference/listings-items-v2021-08-01`
- Product Type Definitions API: `https://developer-docs.amazon.com/sp-api/reference/product-type-definitions-v2020-09-01`
