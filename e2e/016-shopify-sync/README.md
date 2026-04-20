# Shopify Order Sync E2E Test

## User Story
As a warehouse manager, I want to see Shopify orders automatically update my inventory shipped counts so that I always know how many items are committed.

## Screenshot Gallery
### 000-initial-inventory
Initial state of inventory before any Shopify order.

### 001-after-shopify-order
Inventory count updated after a Shopify order is placed via webhook.

### 002-after-shopify-refund
Inventory count updated after a Shopify refund is processed.

## Verification
- Verify `shipped` count increases on order.
- Verify `shipped` count decreases on refund.
- Verify `shipped` count matches reconciliation.
