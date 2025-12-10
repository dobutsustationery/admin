# Shopify Integration - Design Document

## Overview

This document outlines the design for integrating the Dobutsu Stationery inventory management system with Shopify, enabling two-way synchronization between our internal inventory tracking and Shopify product listings.

## Problem Statement

Currently, inventory is managed exclusively in our custom admin system, with no connection to Shopify where products are listed and sold. This creates several challenges:

1. **Manual Synchronization**: Inventory levels must be manually updated in both systems
2. **Data Inconsistency**: Risk of overselling when inventory depletes in one system but not the other
3. **Duplicate Entry**: Product information must be entered and maintained in two places
4. **Order Fulfillment Gaps**: Orders placed on Shopify don't automatically update inventory shipped counts
5. **Lack of Visibility**: Product listings on Shopify may not reflect actual inventory availability

## Goals

The integration should:

1. **Synchronize Inventory Levels**: Keep quantity in stock consistent between systems
2. **Enable Two-Way Data Flow**: Support updates originating from either system
3. **Maintain Data Integrity**: Preserve the accuracy of both systems during sync
4. **Support Product Lifecycle**: Handle new products, updates, and discontinuations
5. **Provide Conflict Resolution**: Handle concurrent updates gracefully
6. **Ensure Security**: Protect API credentials and validate all data transfers

## Integration Approach: REST API

### Selected Approach: Shopify REST Admin API

We will use Shopify's REST Admin API as the primary integration method for programmatic access to product and inventory data.

**Why REST API:**
- Real-time synchronization capabilities
- Granular control over data
- Supports webhooks for instant notifications
- Can handle complex workflows
- Official, well-documented APIs
- Reasonable rate limiting (2 requests/second for REST API)
- Simpler to implement and debug than GraphQL
- More familiar to most developers
- Better suited for straightforward CRUD operations

**Key Capabilities:**
- **Products API**: Create, read, update, delete products
- **Inventory API**: Manage inventory levels at specific locations
- **Webhooks**: Receive notifications for inventory changes, orders, etc.
- **Orders API**: Access order data for fulfillment tracking

**Considerations:**
- Requires API credentials and authentication management
- Need to handle API rate limits (2 requests/second)
- Requires error handling and retry logic
- API versioning concerns (Shopify deprecates old versions quarterly)
- Must stay updated with API version changes

### Complementary: CSV for Bulk Operations

While REST API is the primary approach, CSV import/export will be used for:
- Initial bulk import of existing inventory
- Periodic full reconciliation and auditing
- Manual backup and restore operations
- Review and validation before applying large changes

This hybrid strategy provides:
- **Primary automation** via REST API for day-to-day operations
- **Bulk processing** via CSV when appropriate
- **Audit trail** through CSV exports
- **Flexibility** to choose the best tool for each task

## Data Mapping

### Inventory System to Shopify

Our internal `Item` interface maps to Shopify as follows:

| Our Field | Shopify Field | Notes |
|-----------|---------------|-------|
| `janCode` | `sku` (Variant SKU) | Japanese Article Number used as unique identifier |
| `subtype` | `option1` or part of SKU | Product variant (e.g., color, size) |
| `description` | `title` (Product Title) | Product name/description |
| `hsCode` | `harmonized_system_code` | Customs/tariff code (Product level) |
| `image` | `images` array | Product image URL(s) |
| `qty` | `inventory_quantity` | Available stock at inventory location |
| `pieces` | `weight` or custom metafield | Items per package - may use metafield |
| `shipped` | N/A (calculated) | Tracked internally, not synced to Shopify |

### Composite Key Handling

Our system uses a composite key: `itemKey = janCode + subtype`

**Shopify Equivalent:**
- **Product**: Groups variants (e.g., "Cute Cat Stickers")
- **Variant**: Specific version (e.g., "Cute Cat Stickers - Pink")
- **Variant SKU**: Should be set to our `itemKey` for direct lookup

**Strategy:**
1. Use `janCode` as base SKU
2. Append `subtype` to create unique variant SKU
3. Map to single product with multiple variants when subtypes differ only
4. Alternative: Create separate products if items are substantially different

### Shopify-Specific Fields

Additional Shopify fields we may want to populate:

| Shopify Field | Source/Strategy |
|---------------|-----------------|
| `price` | New field or metafield (not currently tracked) |
| `compare_at_price` | For sale pricing (optional) |
| `vendor` | Could default to "Japan" or track separately |
| `product_type` | Could map from HS code or add new field |
| `tags` | Could derive from description keywords |
| `published` | Control visibility (true/false) |
| `inventory_policy` | Set to "deny" (don't oversell) |
| `fulfillment_service` | "manual" for our process |

## Architecture Design

### System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     Dobutsu Admin System                    │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Redux Store│  │  Firestore   │  │ Shopify Sync     │   │
│  │ (inventory)│←→│  (broadcast) │←→│ Service          │   │
│  └────────────┘  └──────────────┘  └──────────────────┘   │
│                                              ↕               │
└──────────────────────────────────────────────────────────────┘
                                               ↕
                                    ┌──────────────────┐
                                    │ Shopify REST API │
                                    │   + Webhooks     │
                                    └──────────────────┘
                                               ↕
┌──────────────────────────────────────────────────────────────┐
│                        Shopify Store                         │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Products   │  │  Inventory   │  │     Orders       │   │
│  │  & Variants │  │   Levels     │  │  (Fulfillment)   │   │
│  └─────────────┘  └──────────────┘  └──────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### Sync Service Architecture

#### Component 1: Shopify Client Library

**Purpose:** Abstraction layer for Shopify API interactions

**Responsibilities:**
- Authenticate with Shopify using API credentials from environment configuration
- Provide typed TypeScript interfaces for API responses
- Handle rate limiting and retries
- Log all API interactions for debugging
- Support REST API endpoints for products, inventory, and orders

**Key Functionality:**
- Get product information
- Update inventory levels
- Create and update products
- Fetch order data
- Sync inventory levels in batches

#### Component 2: Data Transformation Layer

**Purpose:** Convert between internal and Shopify data formats

**Responsibilities:**
- Map internal `Item` structure to Shopify `Product`/`Variant` structure
- Handle composite keys (janCode + subtype) → Shopify SKU
- Validate data before sync
- Apply business rules (e.g., minimum stock levels, required fields)

**Key Transformations:**
- Item to Shopify Product/Variant
- Shopify Product/Variant to Item
- Inventory level updates (bidirectional)
- Order data from Shopify to internal format

#### Component 3: Sync Coordinator

**Purpose:** Orchestrate bidirectional synchronization

**Responsibilities:**
- Determine what needs to sync (diff detection)
- Coordinate sync operations in correct order
- Handle conflicts (last-write-wins, manual review, etc.)
- Maintain sync state and history in Firestore
- Provide sync status/progress reporting

**Key Operations:**
- Sync inventory to Shopify (admin → Shopify)
- Sync from Shopify (Shopify → admin)
- Full reconciliation (compare and resolve differences)
- Scheduled sync (periodic updates)

#### Component 4: Webhook Handler

**Purpose:** Receive and process Shopify webhook notifications

**Responsibilities:**
- Verify webhook authenticity (HMAC validation)
- Process inventory updates from Shopify
- Process order events for fulfillment tracking
- Queue updates to Redux store via Firestore broadcast
- Handle webhook failures and retries

**Webhook Types to Handle:**
- Inventory level updates
- Order creation
- Order fulfillment
- Product updates

### Data Flow Scenarios

#### Scenario 1: Inventory Update (Admin → Shopify)

```
1. User scans item in admin, updates quantity
2. Redux action dispatched: update_field({ id, field: 'qty', to: newQty })
3. Action broadcast to Firestore
4. Shopify Sync Service detects inventory change
5. ShopifyClient.updateInventory(sku, newQty) called
6. Shopify API updates inventory level
7. Sync log updated with result
```

#### Scenario 2: Order Fulfillment (Shopify → Admin)

```
1. Order placed on Shopify store
2. Shopify sends webhook: orders/create
3. Webhook handler validates and processes
4. Creates new_order action
5. Broadcasts to Firestore → Redux
6. Admin UI shows new order for packing
7. User packs order, scans items
8. package_item actions update shipped quantities
9. (Optional) Admin marks order as fulfilled in Shopify
```

#### Scenario 3: Bulk Product Import (CSV → Shopify)

```
1. Admin exports inventory: GET /csv
2. User downloads CSV
3. User transforms to Shopify CSV format
4. User uploads to Shopify admin
5. Shopify bulk imports products
6. (Later) Sync service reconciles any differences
```

#### Scenario 4: Inventory Reconciliation (Bidirectional)

```
1. Admin triggers full reconciliation
2. Sync service fetches all items from both systems
3. Compares quantities by SKU
4. Identifies discrepancies
5. Applies conflict resolution strategy:
   - If 'ours': Update Shopify to match admin
   - If 'theirs': Update admin to match Shopify  
   - If 'manual': Flag for review
6. Generates reconciliation report
```

## Implementation Plan

### Phase 1: Foundation (MVP)

**Goal:** One-way sync from admin to Shopify (inventory levels only)

**Tasks:**
1. Set up Shopify API credentials in staging and production environments
2. Create Shopify development store for testing
3. Implement REST API client for basic inventory operations
4. Create data transformation layer for Item → Inventory update
5. Build manual sync trigger in admin UI
6. Add sync status/result display
7. Implement error handling and logging to Firestore

**Key Components:**
- Shopify API client module
- Data transformation/mapping module
- Sync coordinator service
- Admin UI page for sync management
- Environment configuration for credentials
- Sync logging and error tracking

**Testing Approach:**
- Test data transformations with sample items
- Integration test with development store
- Manual verification of inventory sync
- Error handling verification

### Phase 2: Automation & Webhooks

**Goal:** Automatic sync and receive updates from Shopify

**Tasks:**
1. Create SvelteKit API endpoint for receiving webhooks
2. Implement HMAC signature verification for webhook security
3. Set up webhook subscriptions in Shopify admin (both stores)
4. Add automatic sync trigger on inventory changes in admin
5. Implement retry logic with exponential backoff for failed syncs
6. Create Firestore collection for sync history and audit log
7. Add monitoring and alerting for sync failures

**Key Components:**
- Webhook receiver endpoint
- Webhook signature validation
- Automatic sync triggers
- Retry queue system
- Sync history/audit logging
- Admin dashboard for monitoring

**Testing Approach:**
- Webhook signature validation tests
- End-to-end webhook delivery tests
- Failure and retry scenario testing
- Sync monitoring verification

### Phase 3: Product Management

**Goal:** Full product sync including descriptions, images, metadata

**Tasks:**
1. Extend data mapper to handle complete product data
2. Implement product creation in Shopify via API
3. Support product updates (descriptions, images, pricing)
4. Add support for product variants and options
5. Implement CSV export in Shopify-compatible format
6. Add CSV import from Shopify exports
7. Handle product lifecycle (creation, updates, archiving)

**Key Components:**
- Enhanced product data mapping
- Product CRUD operations
- Variant management
- CSV export/import utilities
- Product synchronization logic
- Image handling and upload

**Testing Approach:**
- Product creation and update tests
- Variant handling tests
- CSV format validation
- Round-trip sync testing

### Phase 4: Advanced Features

**Goal:** Conflict resolution, analytics, and optimization

**Tasks:**
1. Implement bidirectional sync with conflict detection
2. Add conflict resolution strategies (manual, automatic)
3. Create sync analytics dashboard
4. Optimize API usage with batch operations
5. Implement scheduled reconciliation (cron jobs)
6. Build UI for reviewing and resolving conflicts manually
7. Add inventory forecasting based on sync data

**Key Components:**
- Conflict detection engine
- Resolution strategy framework
- Analytics dashboard
- Batch API optimization
- Scheduled job system
- Conflict resolution UI
- Reporting and insights

**Testing Approach:**
- Conflict detection scenarios
- Resolution strategy validation
- Performance testing with large datasets
- Scheduled job reliability testing

## Shopify API Credentials Setup

### Overview

To integrate with Shopify, you need API credentials that allow your admin system to authenticate and interact with the Shopify store. We'll set up separate credentials for staging (development stores) and production to ensure safe testing and deployment.

### Types of Shopify Apps

Shopify offers different types of apps for API access:

1. **Custom Apps (Recommended for this integration):**
   - Created directly in the Shopify admin
   - Simple setup process
   - Private to your store
   - Best for internal integrations
   - Full control over API scopes
   - Generate admin API access tokens

2. **Private Apps (Legacy):**
   - Being phased out by Shopify
   - Not recommended for new integrations
   - Use Custom Apps instead

### Creating Custom Apps for API Access

#### For Development/Staging Store:

1. **Access Your Development Store:**
   - Log into Shopify Partner Dashboard
   - Navigate to your development store
   - Click "Log in" to access the store admin

2. **Enable Custom App Development:**
   - In the store admin, go to "Settings" > "Apps and sales channels"
   - Click "Develop apps" (or "Develop apps for your store")
   - If prompted, click "Allow custom app development"

3. **Create a Custom App:**
   - Click "Create an app"
   - Enter app name: "Dobutsu Admin Integration - Staging"
   - Select an app developer (your partner account email)
   - Click "Create app"

4. **Configure API Scopes:**
   - Click "Configure Admin API scopes"
   - Select the following scopes:
     - **Products:** `read_products`, `write_products`
     - **Inventory:** `read_inventory`, `write_inventory`
     - **Orders:** `read_orders` (for order fulfillment tracking)
   - Click "Save"

5. **Install the App:**
   - Click "Install app"
   - Review the permissions
   - Click "Install" to confirm

6. **Get API Credentials:**
   - After installation, click "API credentials" tab
   - You'll see:
     - **Admin API access token** (starts with `shpat_`)
     - **API key** and **API secret key**
   - Copy the "Admin API access token" - this is your staging access token
   - Store it securely (you won't be able to see it again)

7. **Note Your Store URL:**
   - Your development store URL (e.g., `your-dev-store.myshopify.com`)
   - This is needed for API requests

#### For Production Store:

Follow the exact same steps as above in your production Shopify store, but:
- Name the app: "Dobutsu Admin Integration - Production"
- Use extra caution with permissions
- Store credentials even more securely
- Consider additional access controls

**⚠️ Production Security Notes:**
- Limit API scopes to only what's absolutely necessary
- Regularly audit API access logs in Shopify
- Rotate credentials periodically (e.g., every 90 days)
- Never share production credentials
- Use secure storage solutions

### Credential Management in the Admin System

Our admin system uses environment variables to manage configuration across different environments (local, staging, production). This aligns with the existing Firebase configuration pattern.

#### Environment Variable Structure

Following the pattern established for Firebase credentials, Shopify credentials will be stored in environment-specific configuration files:

**`.env.example`** - Template and documentation (committed to git):
```bash
# Shopify Integration Configuration

# Staging/Development Store Configuration
# Get these from your Shopify Partner development store
# VITE_SHOPIFY_STAGING_STORE_URL=your-dev-store.myshopify.com
# SHOPIFY_STAGING_ACCESS_TOKEN=shpat_your_staging_token_here
# VITE_SHOPIFY_STAGING_API_VERSION=2024-01

# Production Store Configuration  
# Get these from your production Shopify store
# VITE_SHOPIFY_PRODUCTION_STORE_URL=dobutsu-stationery.myshopify.com
# SHOPIFY_PRODUCTION_ACCESS_TOKEN=shpat_your_production_token_here
# VITE_SHOPIFY_PRODUCTION_API_VERSION=2024-01

# Webhook Configuration
# Secret key for validating webhooks from Shopify
# SHOPIFY_STAGING_WEBHOOK_SECRET=whsec_your_staging_webhook_secret
# SHOPIFY_PRODUCTION_WEBHOOK_SECRET=whsec_your_production_webhook_secret

# Sync Configuration
# SHOPIFY_SYNC_ENABLED=true
# SHOPIFY_SYNC_INTERVAL=300000  # 5 minutes in milliseconds
# SHOPIFY_AUTO_SYNC=false  # Set to true for automatic background sync
```

**`.env.staging`** - Staging environment configuration:
```bash
# Inherited from base configuration
VITE_FIREBASE_ENV=staging

# Shopify Staging Configuration
VITE_SHOPIFY_STORE_URL=your-dev-store.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_your_staging_token_here
VITE_SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_your_staging_webhook_secret

# Shopify Sync Configuration
SHOPIFY_SYNC_ENABLED=true
SHOPIFY_SYNC_INTERVAL=300000
SHOPIFY_AUTO_SYNC=false
```

**`.env.production`** - Production environment configuration:
```bash
# Inherited from base configuration
VITE_FIREBASE_ENV=production

# Shopify Production Configuration
VITE_SHOPIFY_STORE_URL=dobutsu-stationery.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_your_production_token_here
VITE_SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_your_production_webhook_secret

# Shopify Sync Configuration
SHOPIFY_SYNC_ENABLED=true
SHOPIFY_SYNC_INTERVAL=600000  # 10 minutes for production (less frequent)
SHOPIFY_AUTO_SYNC=true
```

**`.env.emulator`** - Local development configuration:
```bash
# Local development doesn't connect to real Shopify
VITE_FIREBASE_ENV=local

# Shopify configuration disabled for local emulator development
SHOPIFY_SYNC_ENABLED=false
SHOPIFY_AUTO_SYNC=false

# Optional: Use staging credentials for local development if testing Shopify integration
# VITE_SHOPIFY_STORE_URL=your-dev-store.myshopify.com
# SHOPIFY_ACCESS_TOKEN=shpat_your_staging_token_here
# VITE_SHOPIFY_API_VERSION=2024-01
```

#### Environment Variable Naming Convention

Following the existing Firebase pattern:

**Public variables** (safe to expose to client-side code):
- Prefix with `VITE_` to make them available in the browser
- Examples: `VITE_SHOPIFY_STORE_URL`, `VITE_SHOPIFY_API_VERSION`
- These are included in the built application bundle

**Private variables** (server-side only):
- No `VITE_` prefix - only accessible in server-side code
- Examples: `SHOPIFY_ACCESS_TOKEN`, `SHOPIFY_WEBHOOK_SECRET`
- These are never exposed to the client/browser
- Only available in SvelteKit server routes and endpoints

**Environment-specific naming:**
- For staging: Can use either environment-specific naming (e.g., `SHOPIFY_STAGING_ACCESS_TOKEN`) or generic naming in `.env.staging` (e.g., `SHOPIFY_ACCESS_TOKEN`)
- For production: Same pattern as staging
- Generic naming is recommended when using `.env.*` files as they're already environment-specific

#### Setting Up Credentials

**For Development/Testing:**

1. Get your staging credentials from Shopify (as described above)
2. Create or update `.env.staging`:
   ```bash
   cp .env.example .env.staging
   # Edit .env.staging and add your staging credentials
   ```
3. Add your development store URL and access token
4. Set API version to latest stable (check Shopify's API docs)

**For Production:**

1. Get your production credentials from Shopify (as described above)
2. Verify `.env.production` exists or create it:
   ```bash
   cp .env.example .env.production
   # Edit .env.production and add your production credentials
   ```
3. Add your production store URL and access token
4. Use extra caution with these credentials

**For Local Development:**

Local development with emulators doesn't require Shopify credentials unless you're specifically testing the Shopify integration features. In that case:
1. Use staging credentials in `.env.emulator`
2. Set `SHOPIFY_SYNC_ENABLED=true` if testing sync
3. Point to your development store, not production

#### Running with Different Environments

Using the existing npm scripts pattern:

```bash
# Development with staging Shopify credentials
npm run dev:staging

# Development with production Shopify credentials (use with caution)
npm run dev:production

# Local development with emulators (no Shopify connection)
npm run dev:local

# Build for specific environment
npm run build:staging
npm run build:production
```

### Security Best Practices

#### Credential Storage

1. **Never commit credentials to git:**
   - `.env`, `.env.staging`, `.env.production` are already in `.gitignore`
   - Only `.env.example` (template) should be committed
   - Production credentials in `.env.production` should be managed carefully

2. **Use secure credential management:**
   - For deployed production app, consider using Firebase Functions environment config
   - Or use a secrets management service (Google Secret Manager, etc.)
   - For local development, `.env` files are acceptable

3. **Rotate credentials regularly:**
   - Change access tokens every 90 days minimum
   - Rotate immediately if credentials are compromised
   - Update webhook secrets when rotating tokens

4. **Limit credential access:**
   - Only developers who need them should have access
   - Document who has access to production credentials
   - Use Shopify's staff permissions to audit API usage

#### API Scope Management

**Principle of Least Privilege:**
- Only request the minimum scopes needed
- Review scopes before installation
- Remove unused scopes if requirements change

**Current Required Scopes:**
- `read_products` - Read product information
- `write_products` - Update product information and create new products
- `read_inventory` - Read inventory levels
- `write_inventory` - Update inventory quantities
- `read_orders` - Read order information for fulfillment tracking

**Future Scopes (as features are added):**
- `write_orders` - If we need to create or modify orders from the admin
- `read_fulfillments` / `write_fulfillments` - For advanced fulfillment features
- `read_locations` - For multi-location inventory support

#### Webhook Security

Webhook secrets are used to verify that webhooks actually came from Shopify:

1. **Generate webhook secret:**
   - Automatically provided when creating webhooks in Shopify
   - Each webhook can have its own secret or share one

2. **Store securely:**
   - Add to `SHOPIFY_WEBHOOK_SECRET` in environment config
   - Treat as sensitive as the access token

3. **Validate all webhooks:**
   - Use HMAC signature verification
   - Reject webhooks that fail validation
   - Log validation failures for security monitoring

### Credential Verification

After setting up credentials, verify they work:

**Manual Verification:**
1. Use a tool like Postman or curl to test API access
2. Make a simple API call (e.g., GET products)
3. Verify you receive a valid response

**Example test request:**
```bash
curl -X GET \
  'https://your-store.myshopify.com/admin/api/2024-01/products.json?limit=1' \
  -H 'X-Shopify-Access-Token: your_access_token'
```

**Expected response:**
- HTTP 200 status
- JSON response with products array
- No authentication errors

**Common issues:**
- **401 Unauthorized:** Invalid access token
- **403 Forbidden:** Missing required API scope
- **404 Not Found:** Wrong store URL or API version
- **429 Too Many Requests:** Rate limit exceeded (wait and retry)

### Environment Configuration Reference

#### When to Use Each Environment

**Local (Emulator):**
- Daily development of admin features
- Testing non-Shopify functionality
- When working offline
- Fast iteration without external dependencies

**Staging (Development Store):**
- Testing Shopify integration features
- QA and user acceptance testing
- Verifying API interactions
- Safe experimentation with Shopify features

**Production:**
- Final verification before deployment
- Live operations
- Production deployments only
- Real customer data

#### Configuration Summary

| Environment | Firebase | Shopify Store | Shopify Sync | Use Case |
|-------------|----------|---------------|--------------|----------|
| Local | Emulators | None (or staging) | Disabled | Daily development |
| Staging | Staging project | Development store | Enabled | Integration testing |
| Production | Production project | Production store | Enabled | Live operations |

### Troubleshooting Credentials

**"Invalid API token" errors:**
- Verify token was copied correctly (no extra spaces)
- Check token starts with `shpat_`
- Ensure app is installed in the store
- Confirm you're using the right token for the right environment

**"Missing required scope" errors:**
- Review configured API scopes in Shopify
- Add missing scopes in the custom app configuration
- Reinstall the app after adding scopes
- Wait a few minutes for changes to propagate

**Webhook validation failures:**
- Verify webhook secret matches Shopify configuration
- Check HMAC validation implementation
- Ensure using the raw request body for validation
- Confirm webhook is coming from Shopify's IP ranges

**Environment variable not loading:**
- Verify correct `.env.*` file for the environment
- Check file is in project root directory
- Restart development server after changing environment files
- Verify variable naming (VITE_ prefix for client-side variables)

### Next Steps

After setting up credentials:

1. **Verify credentials work** in both staging and production
2. **Test basic API operations** (read products, update inventory)
3. **Configure webhooks** in Shopify admin
4. **Implement sync functionality** using the credentials
5. **Set up monitoring** to track API usage and errors
6. **Document any environment-specific configuration** needed

For implementation details, refer to the relevant sections of this document.

## Data Consistency Strategies

### Conflict Resolution

When the same item is updated in both systems, conflicts can occur.

**Strategies:**

1. **Last-Write-Wins (Timestamp-based)**
   - Compare update timestamps
   - Most recent update takes precedence
   - Simple but may lose intentional changes

2. **Source Priority**
   - Admin system is source of truth for inventory
   - Shopify is source of truth for pricing/descriptions
   - Clear ownership reduces conflicts

3. **Manual Review**
   - Flag conflicts for human review
   - Admin chooses which value to keep
   - Safest but requires intervention

4. **Field-Level Merging**
   - Merge non-conflicting field changes
   - Only flag actual conflicts
   - Most sophisticated approach

**Recommended:** Start with Source Priority, add Manual Review for critical conflicts.

### Synchronization Timing

**Options:**

1. **Real-Time (Event-Driven)**
   - Sync immediately on every change
   - Pros: Always up-to-date
   - Cons: High API usage, network dependency

2. **Batched (Scheduled)**
   - Sync every N minutes/hours
   - Pros: Reduced API calls, more efficient
   - Cons: Temporary inconsistency

3. **Hybrid**
   - Real-time for critical changes (inventory levels)
   - Batched for less critical updates (descriptions)
   - Pros: Balance of timeliness and efficiency
   - Cons: More complex logic

**Recommended:** Hybrid approach with configurable intervals.

### Handling Network Failures

**Strategies:**

1. **Retry Queue**
   - Failed syncs added to queue
   - Retry with exponential backoff
   - Max retry limit (e.g., 5 attempts)

2. **Sync State Tracking**
   - Track last successful sync timestamp
   - Store pending changes locally
   - Resume from last known good state

3. **Manual Reconciliation**
   - Admin-triggered full sync
   - Compare all items, resolve differences
   - Run during maintenance windows

## CSV Integration Details

For users who prefer CSV-based workflows or for bulk operations:

### Export Format (Admin → Shopify)

Generate CSV in Shopify's product import format:

```csv
Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Fulfillment Service,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Variant Barcode,Image Src,Image Position,Image Alt Text,Gift Card,SEO Title,SEO Description,Google Shopping / Google Product Category,Google Shopping / Gender,Google Shopping / Age Group,Google Shopping / MPN,Google Shopping / AdWords Grouping,Google Shopping / AdWords Labels,Google Shopping / Condition,Google Shopping / Custom Product,Google Shopping / Custom Label 0,Google Shopping / Custom Label 1,Google Shopping / Custom Label 2,Google Shopping / Custom Label 3,Google Shopping / Custom Label 4,Variant Image,Variant Weight Unit,Variant Tax Code,Cost per item,Included / Japan,Status,HS Code
```

**Field Mapping Strategy:**
- **Handle:** Use janCode as product identifier
- **Title:** Map from description field
- **Vendor:** Default to "Dobutsu Stationery"
- **Option1 Name/Value:** Use "Style" for option name, subtype for value
- **Variant SKU:** Combine janCode + subtype for unique identifier
- **Variant Inventory Qty:** Map from qty field
- **Variant Inventory Policy:** Set to "deny" to prevent overselling
- **Variant Barcode:** Use janCode
- **Image Src:** Map from image field
- **HS Code:** Map from hsCode field for customs/tariff codes

### Import Format (Shopify → Admin)

Parse Shopify's product export CSV:

**Key Fields:**
- `Variant SKU` → parse into `janCode` and `subtype`
- `Variant Inventory Qty` → `qty`
- `Title` → `description`
- `Variant Barcode` → `janCode` (validation)
- `Image Src` → `image`
- `HS Code` → `hsCode`

### CSV Utilities

**CSV Export Functionality:**
- Export inventory items to Shopify-compatible CSV format
- Transform internal data structure to Shopify's product import schema
- Download CSV file for manual import to Shopify

**CSV Import Functionality:**
- Parse Shopify product export CSV files
- Validate CSV structure and data
- Import product data back into inventory system
- Handle errors and data validation

## Shopify Testing and Staging Environments

### Development Stores for Testing

Shopify provides **Development Stores** (also called Partner Development Stores) that serve as staging/testing environments. These allow you to test the integration without impacting the real production store.

**Key Benefits:**
- **Free to create and use** - No monthly subscription fees for development stores
- **Full Shopify functionality** - Nearly identical to production stores
- **Isolated environment** - Completely separate from production data
- **Safe testing** - Make mistakes without affecting real customers or orders
- **Multiple stores** - Can create multiple development stores for different testing scenarios

**How to Get a Development Store:**

1. **Create a Shopify Partner Account** (if you don't have one):
   - Visit https://www.shopify.com/partners
   - Sign up for a free Shopify Partner account
   - No cost or commitment required

2. **Create a Development Store:**
   - Log into your Partner Dashboard
   - Navigate to "Stores" in the left sidebar
   - Click "Add store"
   - Select "Create development store"
   - Choose "Test store (for developers)" or "Development store"
   - Fill in store details (can use test data)
   - Click "Create development store"

3. **Configure the Development Store:**
   - Add test products manually or import via CSV
   - Configure store settings to match production (or use simplified test settings)
   - Set up inventory locations
   - Install any apps needed for testing

**Development Store Limitations:**

- Cannot process real payments (test mode only)
- Cannot transfer to a merchant (development stores are for testing only)
- Some apps may not be available
- Limited to partner accounts only
- Checkout is restricted to test transactions

**Best Practices:**

1. **Create separate development stores for different purposes:**
   - One for active development/integration testing
   - One for QA/user acceptance testing
   - One for experimenting with new features

2. **Keep test data realistic:**
   - Use similar product structures to production
   - Create representative inventory levels
   - Test with various product types and variants

3. **Document your test store setup:**
   - Record configuration differences from production
   - Document test credentials separately
   - Note any workarounds needed for testing

4. **Sync test data periodically:**
   - Export production catalog (without sensitive data)
   - Import into development store
   - Keeps testing environment realistic

### Production Store

Your production Shopify store is where real customers place orders and make purchases. This should only be used for:
- Final integration verification (after thorough testing in development)
- Live operations
- Production deployments

**⚠️ Important Production Considerations:**
- Always test thoroughly in development stores first
- Use read-only operations when possible during testing
- Monitor API usage to avoid rate limits
- Have rollback procedures ready
- Schedule maintenance windows for significant changes
- Implement comprehensive error handling and logging

## Security Considerations

### API Credentials Security

**Storage Best Practices:**
- Store all Shopify API credentials in environment variables
- Never commit credentials to version control (already handled by .gitignore)
- Use separate credentials for staging and production environments
- Rotate credentials periodically (every 90 days minimum)
- Store production credentials securely (consider using secret management services)

**Access Control:**
- Use Shopify custom apps with minimal required scopes
- Only grant API permissions that are absolutely necessary
- Review and audit API access regularly in Shopify admin
- Limit who has access to production credentials
- Document who has access and when credentials are rotated

**Required API Scopes:**
- `read_products` - Read product data
- `write_products` - Create and update products
- `read_inventory` - Read inventory levels
- `write_inventory` - Update inventory quantities
- `read_orders` - Read order data for fulfillment tracking

**Future Scopes (as needed):**
- `write_orders` - If creating/modifying orders from admin
- `read_fulfillments` / `write_fulfillments` - For advanced fulfillment features
- `read_locations` - For multi-location inventory support

### Webhook Security

**HMAC Signature Verification:**
- Always validate HMAC signature on all incoming webhook requests
- Use crypto.timingSafeEqual to prevent timing attacks
- Reject any webhook that fails validation
- Use the raw request body for HMAC calculation

**Additional Protections:**
- Verify webhook origin (can check Shopify IP ranges if needed)
- Rate limit the webhook endpoint to prevent abuse
- Log all webhook attempts for security auditing
- Monitor for unusual webhook patterns
- Alert on repeated validation failures

**Webhook Secret Management:**
- Store webhook secret in environment variables (never in code)
- Treat webhook secret as sensitive as access token
- Rotate webhook secrets when rotating API credentials
- Use different secrets for staging and production

### Data Validation and Sanitization

**Input Validation (from Shopify):**
- Validate all data received from Shopify before processing
- Sanitize product descriptions and titles to prevent injection
- Verify quantity values are non-negative integers
- Validate SKUs match expected format (janCode + subtype pattern)
- Check that required fields are present
- Validate data types match expectations

**Output Validation (to Shopify):**
- Ensure inventory quantities are accurate before sending
- Validate product data against Shopify schema requirements
- Check for required fields before making API calls
- Verify data format matches Shopify expectations
- Implement dry-run mode for testing changes without applying them

**Business Logic Validation:**
- Enforce minimum/maximum quantity constraints
- Validate price values if syncing pricing
- Check inventory levels before allowing decreases
- Validate product relationships (variants belong to products)

### Error Handling and Monitoring

**Error Handling Strategy:**
- Log all errors to Firestore for review and auditing
- Implement retry logic with exponential backoff for transient failures
- Set maximum retry limits to prevent infinite loops
- Alert administrators of repeated sync failures
- Provide manual override capability for stuck syncs
- Maintain ability to rollback changes if needed

**Monitoring and Alerting:**
- Track sync success/failure rates
- Monitor API usage against rate limits
- Alert when approaching rate limits (e.g., 80% threshold)
- Log all API calls for debugging and auditing
- Monitor webhook delivery success rates
- Track sync duration and performance metrics
- Alert on unusual patterns or errors

**Security Monitoring:**
- Log all authentication attempts
- Monitor for invalid API tokens
- Track failed webhook validations
- Alert on suspicious activity patterns
- Review security logs regularly
- Maintain audit trail of all sync operations

### Metrics to Track

1. **Sync Performance**
   - Sync duration (avg, p95, p99)
   - Items synced per operation
   - API calls per sync
   - Error rate

2. **Data Quality**
   - Items in sync vs. out of sync
   - Conflict count
   - Validation errors
   - Data drift over time

3. **API Usage**
   - Requests per hour
   - Rate limit proximity
   - Webhook deliveries
   - Failed requests

### Logging Strategy

**Log Levels:**
- `ERROR`: Sync failures, API errors, validation failures
- `WARN`: Conflicts detected, rate limit approaching
- `INFO`: Sync started/completed, webhook received
- `DEBUG`: Individual API calls, data transformations

**Log Storage:**
- Firestore collection: `shopify_sync_logs`
- Fields: timestamp, level, operation, details, error, itemCount
- Retention: 90 days (configurable)

### Alerting

**Critical Alerts:**
- Sync failures exceeding threshold (e.g., 5 in 1 hour)
- API authentication failures
- Webhook signature validation failures
- Data corruption detected

**Warning Alerts:**
- High conflict rate (>10% of syncs)
- API rate limit at 80%
- Large inventory discrepancies
- Stale sync (no sync in 24 hours)

## Testing Strategy

### Unit Tests

**Coverage Areas:**
- Data mapping functions (Item ↔ Shopify)
- SKU parsing and generation
- Webhook HMAC verification
- Conflict resolution logic
- CSV parsing and generation

**Test Framework:** Vitest (existing in project)

**Test Principles:**
- Test edge cases and error conditions
- Verify data transformations are bidirectional and lossless
- Test with various product configurations (variants, options, etc.)
- Validate error messages are helpful and actionable
- Mock Shopify API responses for isolation
- Test boundary conditions (empty data, max values, etc.)

### Integration Tests

**Test Against:**
- Shopify test store (free development store)
- Test with sample products
- Verify API interactions
- Test webhook delivery

**Scenarios:**
1. Create product in admin → verify in Shopify
2. Update inventory in admin → verify in Shopify
3. Create order in Shopify → verify webhook received
4. Full bidirectional sync cycle

### E2E Tests

**User Workflows:**
1. Admin scans new item → syncs to Shopify → appears in store
2. Customer orders → webhook → admin shows order → pack → inventory updates
3. Admin runs reconciliation → conflicts resolved → both systems consistent

**Test Framework:** Playwright (existing in project)

## Documentation Requirements

### User Documentation

1. **Setup Guide** (`docs/SHOPIFY_SETUP.md`)
   - Creating Shopify app
   - Configuring API credentials
   - Setting up webhooks
   - First-time sync process

2. **User Manual** (`docs/SHOPIFY_USER_GUIDE.md`)
   - How to sync inventory
   - Resolving conflicts
   - Troubleshooting common issues
   - Best practices

3. **CSV Guide** (`docs/SHOPIFY_CSV.md`)
   - Exporting for Shopify
   - Importing from Shopify
   - CSV format reference
   - Bulk operations

### Developer Documentation

1. **API Reference** (`docs/SHOPIFY_API.md`)
   - ShopifyClient methods
   - Data models and interfaces
   - Error codes and handling
   - Rate limiting guidance

2. **Architecture** (this document)
   - Design decisions
   - Data flow diagrams
   - Security considerations
   - Future enhancements

## Cost Considerations

### Shopify API Costs

- **Basic Shopify Plan:** $39/month (includes API access)
- **API Calls:** No additional cost (subject to rate limits)
- **Webhooks:** Free
- **Development Store:** Free for testing

### Development Effort

**Estimated Time:**
- Phase 1 (MVP): 40-60 hours
- Phase 2 (Automation): 30-40 hours
- Phase 3 (Product Sync): 40-50 hours
- Phase 4 (Advanced): 30-40 hours
- **Total:** 140-190 hours

### Ongoing Maintenance

- Monitor API version updates (quarterly)
- Update for Shopify platform changes
- Review and resolve sync conflicts
- Optimize performance based on usage

## Recommended Approach

Based on the analysis above, the recommended implementation strategy is:

### Immediate (Phase 1): REST API with CSV for Bulk Setup

**Why:**
1. **CSV for Initial Setup:**
   - Use existing admin CSV export functionality
   - Create Shopify CSV formatter
   - One-time bulk import to Shopify
   - Manual process acceptable for initial setup
   - Easy to review before importing

2. **REST API for Ongoing Sync:**
   - Implement inventory-level sync via REST API
   - Real-time or near-real-time updates for stock changes
   - Simple, focused scope for initial implementation
   - Immediate value from automated inventory sync
   - Easier to implement and debug than GraphQL

**Benefits:**
- Quick initial setup via CSV
- Automated ongoing operations via REST API
- Lower implementation complexity
- Clear separation of concerns
- Proven, stable technology

### Near-Term (Phase 2): Webhooks for Shopify → Admin

**Why:**
- Enables automatic order import from Shopify
- Keeps admin system informed of Shopify-side changes
- Foundation for bidirectional synchronization
- Essential for real-time inventory accuracy

**Implementation Priorities:**
- SvelteKit API endpoint for receiving webhooks
- Process order creation events
- Process inventory update events
- Update shipped quantities automatically in admin
- Secure webhook validation

### Long-Term (Phases 3-4): Full Product Sync and Advanced Features

**Why:**
- Complete automation of product lifecycle
- Full product information management
- Reduces manual work significantly
- Advanced conflict resolution
- Analytics and insights

**Deferred Because:**
- More complex to implement properly
- Inventory sync alone provides immediate value
- Can be added incrementally as needs arise
- Allows time to learn from initial implementation

## Future Enhancements

### Advanced Features

1. **Multi-Location Support**
   - Shopify supports multiple inventory locations
   - Could map to physical warehouses
   - Separate inventory tracking per location

2. **Pricing Sync**
   - Currently not tracked in admin system
   - Would need to add price field to Item
   - Sync pricing and sale prices

3. **Product Collections**
   - Group products into collections in Shopify
   - Could auto-generate from tags or categories
   - Improve storefront organization

4. **SEO Optimization**
   - Auto-generate SEO titles and descriptions
   - Optimize product tags for search
   - Image alt text from descriptions

5. **Analytics Integration**
   - Sync sales data from Shopify
   - Generate inventory turnover reports
   - Predict restock needs

6. **Inventory Forecasting**
   - Analyze sales trends
   - Predict stock-outs
   - Suggest reorder quantities

### Integration with Other Platforms

1. **Amazon:** Similar approach could work for Amazon Seller Central
2. **eBay:** Use eBay API for marketplace integration
3. **Square:** Point-of-sale integration for retail locations
4. **QuickBooks:** Accounting integration for financial reporting

## Conclusion

This design provides a comprehensive roadmap for Shopify integration with our inventory system. The phased approach allows us to:

1. **Start Simple:** CSV export + basic API sync
2. **Add Automation:** Webhooks and background sync
3. **Scale Up:** Full product management and advanced features
4. **Maintain Quality:** Security, testing, and monitoring throughout

The hybrid approach balances implementation complexity with practical value, ensuring we can deliver working functionality quickly while building toward a comprehensive solution.

## Appendix A: Shopify API Reference

### Key Endpoints

**REST API:**
- `GET /admin/api/2024-01/products.json` - List products
- `POST /admin/api/2024-01/products.json` - Create product
- `PUT /admin/api/2024-01/products/{id}.json` - Update product
- `POST /admin/api/2024-01/inventory_levels/set.json` - Set inventory level
- `GET /admin/api/2024-01/orders.json` - List orders

**GraphQL API:**
- Endpoint: `POST /admin/api/2024-01/graphql.json`
- More efficient for complex queries
- Recommended for production use

### Rate Limits

**REST API:**
- Standard: 2 requests/second
- Shopify Plus: 4 requests/second
- Bucket size: 40 (can burst)

**GraphQL API:**
- Cost-based system (50 points/second)
- Query cost varies by complexity
- More generous for batch operations

### Webhook Topics

Relevant webhooks for our integration:

- `products/create` - New product created
- `products/update` - Product updated
- `products/delete` - Product deleted
- `inventory_levels/update` - Inventory changed
- `orders/create` - New order placed
- `orders/fulfilled` - Order fulfilled
- `fulfillments/create` - Fulfillment created

## Appendix B: Implementation Patterns

### Inventory Sync Pattern

**Conceptual Flow:**
1. Collect items that need syncing from the inventory store
2. Transform each item to Shopify's inventory update format
3. For each item, construct the SKU (janCode + subtype)
4. Make API call to update inventory level at the appropriate location
5. Track success and failures in result object
6. Log all operations to Firestore for audit trail
7. Return comprehensive sync report with successes and failures

**Error Handling:**
- Catch and log each individual item failure
- Continue processing remaining items even if some fail
- Include detailed error messages in the failure log
- Retry transient failures with exponential backoff
- Report overall sync status at completion

### Webhook Handler Pattern

**Conceptual Flow:**
1. Receive POST request from Shopify webhook
2. Extract raw request body (needed for HMAC verification)
3. Extract HMAC signature from request header
4. Extract webhook topic from request header
5. Verify HMAC signature using webhook secret
6. If verification fails, return 401 Unauthorized immediately
7. Parse JSON payload
8. Route to appropriate handler based on webhook topic
9. Process the webhook data (update inventory, create orders, etc.)
10. Return 200 OK to acknowledge receipt
11. Log webhook processing result

**Security Measures:**
- Always verify HMAC before processing
- Use timing-safe comparison for HMAC validation
- Log all webhook attempts for security monitoring
- Rate limit the webhook endpoint
- Return minimal information in error responses

### Sync Coordination Pattern

**Conceptual Flow:**
1. Determine sync direction (to Shopify, from Shopify, or bidirectional)
2. If dry-run mode, prepare to simulate without actual changes
3. Fetch current state from both systems
4. Compare states to identify differences
5. Apply conflict resolution strategy for conflicts
6. Generate list of changes needed in each system
7. Execute changes in dependency order
8. Track progress and results
9. Generate comprehensive sync report
10. Store sync history in Firestore

**Conflict Resolution:**
- Detect when same item changed in both systems
- Apply configured strategy (ours, theirs, manual)
- Log all conflicts for review
- Provide UI for manual conflict resolution
- Maintain audit trail of conflict resolutions

## Appendix C: Configuration Reference

### Environment Variables Template

The Shopify integration uses environment variables following the same pattern as Firebase configuration. See the "Shopify API Credentials Setup" section earlier in this document for detailed configuration examples.

**Key Environment Variables:**

**For Staging:**
- `VITE_SHOPIFY_STORE_URL` - Development store URL
- `SHOPIFY_ACCESS_TOKEN` - API access token (keep secret)
- `VITE_SHOPIFY_API_VERSION` - API version (e.g., 2024-01)
- `SHOPIFY_WEBHOOK_SECRET` - Webhook validation secret
- `SHOPIFY_SYNC_ENABLED` - Enable/disable sync
- `SHOPIFY_SYNC_INTERVAL` - Sync frequency in milliseconds
- `SHOPIFY_AUTO_SYNC` - Enable automatic background sync

**For Production:**
- Same variables as staging but with production values
- More conservative sync interval recommended
- Extra security precautions

**Variable Naming:**
- `VITE_` prefix: Exposed to client-side code (public)
- No prefix: Server-side only (private, secure)

### Shopify Custom App Configuration

When creating a custom app in Shopify admin:

**Required Information:**
- App name: "Dobutsu Admin Inventory Sync - [Staging|Production]"
- API scopes (see Security Considerations section)
- Webhook subscriptions (configured separately in Shopify admin)

**API Scopes to Select:**
- Products: read_products, write_products
- Inventory: read_inventory, write_inventory
- Orders: read_orders

**Webhook Configuration:**
- Configured in Shopify admin after app creation
- Point to your webhook endpoint URL
- Select webhook topics to subscribe to
- Shopify provides webhook secret for HMAC validation

**Webhook Endpoint URL Format:**
- Staging: `https://your-staging-domain.com/api/shopify/webhook`
- Production: `https://admin.dobutsustationery.com/api/shopify/webhook`

**Webhook Topics to Subscribe:**
- `orders/create` - New order notifications
- `inventory_levels/update` - Inventory change notifications
- Additional topics as features are added

## References

- [Shopify Admin API Documentation](https://shopify.dev/api/admin)
- [Shopify GraphQL Admin API](https://shopify.dev/api/admin-graphql)
- [Shopify Webhooks Guide](https://shopify.dev/apps/webhooks)
- [Product CSV Import Format](https://help.shopify.com/en/manual/products/import-export/using-csv)
- [Shopify API Rate Limits](https://shopify.dev/api/usage/rate-limits)
- [Inventory Management](https://shopify.dev/apps/fulfillment/inventory-management-apps)
