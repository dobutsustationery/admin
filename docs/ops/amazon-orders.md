# Amazon orders

Amazon merchant-fulfilled UK orders enter the existing Orders screen through
`amazon_order_reconciled` broadcast events. The integration uses Orders API
2026-01-01 (`FULFILLMENT,CANCELLATION`), not the deprecated v0 API. It does not
request buyer names, addresses or contact information.

Pending orders allocate stock immediately using the existing `shipped` inventory
counter, as other marketplace orders do. This counter represents committed stock
as well as physical shipments. `UNSHIPPED` shows **Ready to ship**. Shipping does
not deduct again. Confirmed order/item cancellations release their allocation;
a buyer cancellation request shows a warning and retains stock until confirmed.
Unknown or ambiguous SKUs appear as unmatched order lines; the importer does not
choose an arbitrary variant. Amazon order quantities are read-only locally so
packing cannot deduct the same order twice. Fulfilment, tracking and cancellation
remain in Seller Central; this change does not implement outbound shipping APIs.

## Events and stored state

Each event has `{order, source, notification?}`. `source` is `reconcile` or
`notification`. `order` contains `orderId`, `marketplaceId`, `purchaseDate`,
`lastUpdatedDate`, `status`, `latestShipDate`, and sorted `lines` containing `id`,
`sku`, `title`, `quantity`, `quantityShipped`, `quantityCancelled`,
`buyerRequestedCancel`. Notification metadata contains its ID, order ID and change
type. The broadcast document ID hashes seller ID and normalized order content,
so duplicate notifications and overlapping reconciliation do not duplicate sales.
Reducers ignore snapshots older than the last Amazon update and apply only the
change in each order's stock allocation.

`orderIdToOrder["amazon:<orderId>"]` stores optional `amazonFacts` with per-line
inventory attribution, reconciled timestamp and marketplace ID. Existing caches
initialize these only when new Amazon events arrive. On upgrade, a targeted query
recovers only `amazon_order_reconciled` events that an older tab may have consumed
without applying. Recovery preserves the full-log cursor and records an optional
`amazonOrdersRecovered` cache marker. **Schema version unchanged; no full replay.**

Operational state lives in `amazon_order_sync_state/default`: reconciliation
cursor, in-progress page token/window, last successful check, imported count,
notification configuration/poll time and separate API/queue errors. It is readable
by signed-in users, writable only by the server. Errors and last successful check
appear above the Orders table. `request_amazon_orders` queues a manual refresh;
its server progress is recorded in `sync` for hedgehoggy.

## Reconciliation

`amazonOrderReconcile` runs every five minutes. The first run imports orders
updated in the preceding seven days. Later runs overlap the completed cursor by
five minutes and leave Amazon's required two-minute visibility window. Each page
is persisted before its cursor advances; a failed page is retried. The final
cursor advances only after the whole window succeeds. This also recovers the test
order placed before notification subscription. Use **Refresh Amazon orders** for
an immediate server-side check.

## Connect notifications

Amazon delivers `ORDER_CHANGE` to a **standard AWS SQS queue**. The scheduled
`amazonOrderNotifications` worker long-polls it once a minute, retrieves canonical
order state, persists the event, then acknowledges the message. This gives roughly
one-minute pickup in normal conditions; reconciliation remains the fallback.
No public unauthenticated webhook is exposed.

1. In the intended AWS account, create a dedicated standard queue in `eu-west-1`
   (or configure another supported region). Grant Amazon's SP-API service the
   documented `sqs:SendMessage` queue permission. Follow Amazon's instructions:
   <https://developer-docs.amazon/sp-api/docs/set-up-notifications-with-amazon-sqs>.
2. Give the runtime credentials only `sqs:ReceiveMessage` and `sqs:DeleteMessage`
   on that queue. The setup command additionally needs `sqs:GetQueueAttributes`.
3. Add these keys to the gitignored `.env.amazon` (do not put credentials in docs):
   `AMAZON_ORDERS_SQS_QUEUE_URL`, `AMAZON_ORDERS_SQS_REGION`,
   `AMAZON_ORDERS_SQS_ACCESS_KEY_ID`, `AMAZON_ORDERS_SQS_SECRET_ACCESS_KEY`.
4. Run `direnv exec . node scripts/amazon-order-notifications-setup.mjs`.
   It reuses a matching destination/subscription and refuses to replace a
   subscription targeting another queue. Destination registration uses a grantless
   notifications token; subscription uses the seller's existing authorization.
5. Prepare production function environment and deploy the three order functions:
   `amazonOrderReconcile`, `amazonOrderNotifications`, `amazonOrderRefreshRequest`,
   plus Hosting and Firestore rules for the screen/manual refresh.
6. Check the Orders screen for a successful queue poll. Change a real test order
   from pending to unshipped, then confirm the status arrives without a second
   stock deduction. Cancellation must return stock exactly once.

Without SQS configuration, reconciliation works and the screen explicitly says
live notifications still need connecting. Orders API access was verified against
production on November 11, 2026; no ORDER_CHANGE subscription existed then.
