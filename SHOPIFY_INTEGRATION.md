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

## Integration Approaches

### Option 1: Shopify Admin API

Use Shopify's REST Admin API or GraphQL Admin API for programmatic access.

**Pros:**
- Real-time synchronization
- Granular control over data
- Supports webhooks for instant notifications
- Can handle complex workflows
- Official, well-documented APIs
- Rate limiting is reasonable (2 requests/second for REST, 50 points/second for GraphQL)

**Cons:**
- Requires API credentials and authentication management
- More complex implementation
- Need to handle API rate limits
- Requires error handling and retry logic
- API versioning concerns (Shopify deprecates old versions)

**Key APIs:**
- **Products API**: Create, read, update, delete products
- **Inventory API**: Manage inventory levels at specific locations
- **Webhooks**: Receive notifications for inventory changes, orders, etc.
- **Orders API**: Access order data for fulfillment tracking

### Option 2: CSV Import/Export

Use Shopify's bulk import/export functionality with CSV files.

**Pros:**
- Simple to implement
- No API credentials needed (can use Shopify admin UI)
- Batch processing is straightforward
- Easy to review changes before applying
- Built-in Shopify validation

**Cons:**
- Manual process (requires downloading/uploading files)
- No real-time sync
- Limited automation potential
- Prone to human error
- No conflict detection
- Cannot receive instant notifications of changes

### Option 3: Hybrid Approach

Combine both methods based on use case.

**Implementation:**
- Use **CSV** for initial bulk import and periodic full reconciliation
- Use **API** for ongoing real-time inventory updates
- Use **Webhooks** to receive notifications of Shopify-side changes

**Pros:**
- Best of both worlds
- Reduced API usage for bulk operations
- Real-time sync for critical inventory updates
- CSV provides backup/audit trail

**Cons:**
- More complex implementation
- Two systems to maintain
- Potential for confusion about which method to use

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
                                    │ Shopify Admin API│
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
- Authenticate with Shopify using API credentials
- Provide typed TypeScript interfaces for API responses
- Handle rate limiting and retries
- Log all API interactions for debugging
- Support both REST and GraphQL APIs

**Implementation:**
```typescript
// src/lib/shopify-client.ts

interface ShopifyConfig {
  shop: string;           // e.g., "dobutsu-stationery.myshopify.com"
  accessToken: string;    // Private app or custom app access token
  apiVersion: string;     // e.g., "2024-01"
}

class ShopifyClient {
  async getProduct(productId: string): Promise<ShopifyProduct>
  async updateInventory(sku: string, quantity: number): Promise<void>
  async createProduct(data: ProductData): Promise<ShopifyProduct>
  async syncInventoryLevels(items: InventoryUpdate[]): Promise<SyncResult>
}
```

#### Component 2: Data Transformation Layer

**Purpose:** Convert between internal and Shopify data formats

**Responsibilities:**
- Map `Item` to Shopify `Product`/`Variant`
- Handle composite keys (janCode + subtype)
- Validate data before sync
- Apply business rules (e.g., minimum stock levels)

**Implementation:**
```typescript
// src/lib/shopify-mapper.ts

interface ItemToShopify {
  toProduct(item: Item): ShopifyProductCreate;
  toVariant(item: Item): ShopifyVariantCreate;
  toInventoryUpdate(item: Item): InventoryLevelUpdate;
}

interface ShopifyToItem {
  fromProduct(product: ShopifyProduct): Partial<Item>[];
  fromVariant(variant: ShopifyVariant): Partial<Item>;
  fromInventoryLevel(level: InventoryLevel): { sku: string; qty: number };
}
```

#### Component 3: Sync Coordinator

**Purpose:** Orchestrate bidirectional synchronization

**Responsibilities:**
- Determine what needs to sync (diff detection)
- Coordinate sync operations in correct order
- Handle conflicts (last-write-wins, manual review, etc.)
- Maintain sync state and history
- Provide sync status/progress reporting

**Implementation:**
```typescript
// src/lib/shopify-sync.ts

interface SyncOptions {
  direction: 'to-shopify' | 'from-shopify' | 'bidirectional';
  dryRun: boolean;
  conflictStrategy: 'ours' | 'theirs' | 'manual';
}

class ShopifySyncCoordinator {
  async syncToShopify(items: Item[]): Promise<SyncReport>
  async syncFromShopify(): Promise<SyncReport>
  async reconcile(): Promise<ConflictReport>
}
```

#### Component 4: Webhook Handler

**Purpose:** Receive and process Shopify webhook notifications

**Responsibilities:**
- Verify webhook authenticity (HMAC validation)
- Process inventory updates from Shopify
- Process order events for fulfillment tracking
- Queue updates to Redux store via Firestore broadcast

**Implementation:**
```typescript
// src/routes/api/shopify-webhook/+server.ts (SvelteKit endpoint)

interface WebhookHandler {
  handleInventoryUpdate(webhook: InventoryWebhook): Promise<void>
  handleOrderCreated(webhook: OrderWebhook): Promise<void>
  handleOrderFulfilled(webhook: FulfillmentWebhook): Promise<void>
}
```

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
1. Set up Shopify API credentials (private/custom app)
2. Implement ShopifyClient with basic inventory API
3. Create data mapper for Item → InventoryLevelUpdate
4. Build manual sync trigger in admin UI
5. Add sync status/result display
6. Document initial setup process

**Deliverables:**
- `src/lib/shopify/client.ts` - API client
- `src/lib/shopify/mapper.ts` - Data transformation
- `src/lib/shopify/sync.ts` - Sync coordinator
- `src/routes/shopify/+page.svelte` - Sync management UI
- Environment variables for Shopify credentials
- Basic error handling and logging

**Testing:**
- Unit tests for mapper functions
- Integration test with Shopify test store
- Manual verification of inventory sync

### Phase 2: Automation & Webhooks

**Goal:** Automatic sync and receive updates from Shopify

**Tasks:**
1. Implement webhook endpoint for Shopify
2. Set up webhook subscriptions in Shopify
3. Add automatic sync on inventory changes
4. Implement retry logic for failed syncs
5. Add sync history/audit log

**Deliverables:**
- `src/routes/api/shopify/webhook/+server.ts` - Webhook handler
- Webhook verification (HMAC)
- Firestore collection for sync logs
- Automatic background sync service

**Testing:**
- Webhook signature validation tests
- End-to-end webhook processing tests
- Failure/retry scenario tests

### Phase 3: Product Management

**Goal:** Full product sync including descriptions, images, pricing

**Tasks:**
1. Extend mapper to handle full product data
2. Implement product creation in Shopify
3. Support product updates (description, images)
4. Add support for variants and options
5. Implement CSV export in Shopify format

**Deliverables:**
- Full product CRUD operations
- Variant management
- Shopify-format CSV exporter
- Product import from Shopify

**Testing:**
- Product creation/update tests
- Variant handling tests
- CSV export/import validation

### Phase 4: Advanced Features

**Goal:** Conflict resolution, analytics, and optimization

**Tasks:**
1. Implement bidirectional sync with conflict detection
2. Add sync analytics and reporting
3. Optimize API usage (batch operations)
4. Add scheduled reconciliation
5. Implement manual conflict resolution UI

**Deliverables:**
- Conflict detection and resolution
- Sync dashboard with metrics
- Batch API operations
- Scheduled jobs for reconciliation
- Admin UI for reviewing conflicts

## Security Considerations

### API Credentials

**Storage:**
- Store Shopify API credentials in environment variables
- Never commit credentials to version control
- Use separate credentials for staging vs. production
- Rotate credentials periodically

**Access Control:**
- Use Shopify custom/private apps with minimal required scopes
- Required scopes:
  - `read_products` - Read product data
  - `write_products` - Update products
  - `read_inventory` - Read inventory levels
  - `write_inventory` - Update inventory levels
  - `read_orders` - Read order data (for fulfillment)

### Webhook Security

**Verification:**
- Validate HMAC signature on all webhook requests
- Verify webhook origin (Shopify IP ranges if needed)
- Rate limit webhook endpoint to prevent abuse
- Log all webhook attempts for security auditing

**Implementation:**
```typescript
function verifyShopifyWebhook(
  body: string,
  hmacHeader: string,
  secret: string
): boolean {
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(hmacHeader)
  );
}
```

### Data Validation

**Input Validation:**
- Validate all data received from Shopify before processing
- Sanitize product descriptions and titles
- Verify quantity values are non-negative integers
- Validate SKUs match expected format

**Output Validation:**
- Ensure inventory quantities are accurate before sending
- Validate product data against Shopify schema
- Check for required fields before API calls
- Implement dry-run mode for testing

### Error Handling

**Strategies:**
- Log all errors to Firestore for review
- Implement retry logic with exponential backoff
- Alert admins of repeated sync failures
- Provide manual override for stuck syncs
- Maintain rollback capability

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

**Mapper Function:**
```typescript
function itemToShopifyCSV(item: Item): string[] {
  return [
    item.janCode,                    // Handle (product identifier)
    item.description,                // Title
    '',                              // Body (HTML)
    'Dobutsu Stationery',           // Vendor
    '',                              // Product Category
    '',                              // Type
    '',                              // Tags
    'TRUE',                          // Published
    'Style',                         // Option1 Name
    item.subtype,                    // Option1 Value
    `${item.janCode}${item.subtype}`, // Variant SKU
    '',                              // Variant Grams
    'shopify',                       // Variant Inventory Tracker
    item.qty.toString(),             // Variant Inventory Qty
    'deny',                          // Variant Inventory Policy
    'manual',                        // Variant Fulfillment Service
    '',                              // Variant Price (TODO)
    '',                              // Variant Compare At Price
    'TRUE',                          // Variant Requires Shipping
    'TRUE',                          // Variant Taxable
    item.janCode,                    // Variant Barcode
    item.image,                      // Image Src
    '1',                             // Image Position
    item.description,                // Image Alt Text
    'FALSE',                         // Gift Card
    // ... SEO and Google Shopping fields
    item.hsCode,                     // HS Code
  ];
}
```

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

```typescript
// src/lib/shopify/csv.ts

interface ShopifyCSVExporter {
  exportProducts(items: Item[]): Promise<string>;
  downloadCSV(csv: string, filename: string): void;
}

interface ShopifyCSVImporter {
  parseCSV(csv: string): Promise<ShopifyProduct[]>;
  validateCSV(csv: string): ValidationResult;
  importToInventory(products: ShopifyProduct[]): Promise<ImportResult>;
}
```

## Alternative: Shopify GraphQL API

For more efficient operations, consider using GraphQL instead of REST:

**Advantages:**
- Fetch exactly the data needed (no over-fetching)
- Batch mutations in single request
- Better performance for complex queries
- More modern and actively developed

**Example Query:**
```graphql
query getProductInventory($first: Int!) {
  products(first: $first) {
    edges {
      node {
        id
        title
        variants(first: 100) {
          edges {
            node {
              id
              sku
              inventoryQuantity
              inventoryItem {
                id
              }
            }
          }
        }
      }
    }
  }
}
```

**Example Mutation:**
```graphql
mutation inventoryAdjust($inventoryItemId: ID!, $delta: Int!) {
  inventoryAdjustQuantity(
    input: {
      inventoryItemId: $inventoryItemId
      availableDelta: $delta
    }
  ) {
    inventoryLevel {
      id
      available
    }
    userErrors {
      field
      message
    }
  }
}
```

## Monitoring & Observability

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

**Example:**
```typescript
// tests/shopify-mapper.test.ts
describe('ShopifyMapper', () => {
  it('converts Item to Shopify variant', () => {
    const item: Item = {
      janCode: '4901234567890',
      subtype: 'pink',
      description: 'Cute Cat Stickers',
      hsCode: '4821.10',
      image: 'https://example.com/cat.jpg',
      qty: 100,
      pieces: 5,
      shipped: 20,
    };
    
    const variant = itemToShopifyVariant(item);
    
    expect(variant.sku).toBe('4901234567890pink');
    expect(variant.inventory_quantity).toBe(100);
    expect(variant.barcode).toBe('4901234567890');
  });
});
```

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

### Immediate (Phase 1): Hybrid CSV + API

**Why:**
1. **CSV for Initial Setup:**
   - Use existing `/csv` export functionality
   - Create Shopify CSV formatter
   - One-time bulk import to Shopify
   - Manual process acceptable for setup

2. **API for Ongoing Sync:**
   - Implement inventory-level sync only
   - Real-time updates for stock changes
   - Simple, focused scope
   - Immediate value

**Implementation:**
```typescript
// 1. Enhanced CSV export
export async function exportShopifyCSV(items: Item[]): Promise<string> {
  // Transform to Shopify format
  // Add required headers
  // Return formatted CSV
}

// 2. Simple inventory sync
export async function syncInventoryToShopify(
  items: Item[],
  client: ShopifyClient
): Promise<SyncResult> {
  // For each item
  // Update inventory level via API
  // Log results
}
```

### Near-Term (Phase 2): Webhooks

**Why:**
- Enables automatic order import
- Keeps admin system informed of Shopify changes
- Foundation for bidirectional sync

**Implementation:**
- SvelteKit API endpoint for webhooks
- Process order events
- Update shipped quantities automatically

### Long-Term (Phases 3-4): Full Product Sync

**Why:**
- Complete automation
- Full product lifecycle management
- Reduces manual work significantly

**Deferred Because:**
- More complex to implement
- Initial value from inventory sync alone
- Can be added incrementally

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

## Appendix B: Example Implementations

### Example: Simple Inventory Sync

```typescript
// src/lib/shopify/simple-sync.ts
import type { Item } from '$lib/inventory';
import { ShopifyClient } from './client';

export async function syncInventoryLevels(
  items: Item[],
  shopifyConfig: ShopifyConfig
): Promise<SyncResult> {
  const client = new ShopifyClient(shopifyConfig);
  const results: SyncResult = {
    success: [],
    failed: [],
    total: items.length,
  };

  for (const item of items) {
    try {
      const sku = `${item.janCode}${item.subtype}`;
      await client.updateInventory(sku, item.qty);
      results.success.push(sku);
    } catch (error) {
      results.failed.push({
        sku: `${item.janCode}${item.subtype}`,
        error: error.message,
      });
    }
  }

  return results;
}
```

### Example: Webhook Handler

```typescript
// src/routes/api/shopify/webhook/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { verifyWebhook } from '$lib/shopify/webhook-verify';
import { processOrderCreated } from '$lib/shopify/webhook-handlers';

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  const hmac = request.headers.get('x-shopify-hmac-sha256');
  const topic = request.headers.get('x-shopify-topic');

  // Verify webhook authenticity
  if (!verifyWebhook(body, hmac, process.env.SHOPIFY_WEBHOOK_SECRET)) {
    return json({ error: 'Invalid signature' }, { status: 401 });
  }

  const payload = JSON.parse(body);

  // Route to appropriate handler
  switch (topic) {
    case 'orders/create':
      await processOrderCreated(payload);
      break;
    case 'inventory_levels/update':
      await processInventoryUpdate(payload);
      break;
    default:
      console.log(`Unhandled webhook topic: ${topic}`);
  }

  return json({ received: true });
};
```

## Appendix C: Configuration Example

### Environment Variables

```bash
# .env.production (add these)

# Shopify API Configuration
VITE_SHOPIFY_SHOP=dobutsu-stationery.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx  # Keep secret!
SHOPIFY_API_VERSION=2024-01
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxx   # Keep secret!

# Sync Configuration
SHOPIFY_SYNC_ENABLED=true
SHOPIFY_SYNC_INTERVAL=300000  # 5 minutes in ms
SHOPIFY_AUTO_SYNC=true
```

### Shopify App Configuration

```json
{
  "name": "Dobutsu Admin Inventory Sync",
  "scopes": [
    "read_products",
    "write_products",
    "read_inventory",
    "write_inventory",
    "read_orders"
  ],
  "webhooks": [
    {
      "topic": "orders/create",
      "address": "https://admin.dobutsustationery.com/api/shopify/webhook"
    },
    {
      "topic": "inventory_levels/update",
      "address": "https://admin.dobutsustationery.com/api/shopify/webhook"
    }
  ]
}
```

## References

- [Shopify Admin API Documentation](https://shopify.dev/api/admin)
- [Shopify GraphQL Admin API](https://shopify.dev/api/admin-graphql)
- [Shopify Webhooks Guide](https://shopify.dev/apps/webhooks)
- [Product CSV Import Format](https://help.shopify.com/en/manual/products/import-export/using-csv)
- [Shopify API Rate Limits](https://shopify.dev/api/usage/rate-limits)
- [Inventory Management](https://shopify.dev/apps/fulfillment/inventory-management-apps)
