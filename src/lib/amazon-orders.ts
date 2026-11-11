export interface AmazonOrderSnapshot {
  orderId: string;
  marketplaceId: string;
  purchaseDate: string;
  lastUpdatedDate: string;
  status: string;
  latestShipDate: string;
  lines: {
    id: string;
    sku: string;
    title: string;
    quantity: number;
    quantityShipped: number;
    quantityCancelled: number;
    buyerRequestedCancel: boolean;
  }[];
}
export function amazonOrderLabel(order: {
  amazonFacts?: unknown;
  status?: string;
  unmatchedLines?: unknown[];
  buyerRequestedCancel?: boolean;
}) {
  if (!order.amazonFacts) return "";
  if (order.buyerRequestedCancel)
    return "Cancellation requested — review in Amazon";
  if (order.unmatchedLines?.length) return "Needs SKU matching";
  return (
    (
      {
        PENDING: "Pending payment — do not ship",
        PENDING_AVAILABILITY: "Pending availability — do not ship",
        UNSHIPPED: "Ready to ship",
        PARTIALLY_SHIPPED: "Partially shipped",
        SHIPPED: "Shipped",
        CANCELLED: "Canceled",
        UNFULFILLABLE: "Unfulfillable",
      } as Record<string, string>
    )[order.status || ""] ||
    order.status ||
    ""
  );
}
