import { toTimestampMs } from "./timestamped-action";

// Upgrade only the new channel's facts, preserving the full-log resume cursor.
// Old builds can consume unknown events and save a snapshot past them.
export function recoverAmazonOrderEvents(
  store: { dispatch: (action: any) => any },
  events: { id: string; [key: string]: any }[],
) {
  const ordered = [...events].sort(
    (a, b) =>
      (toTimestampMs(a.timestamp) || 0) - (toTimestampMs(b.timestamp) || 0) ||
      a.id.localeCompare(b.id),
  );
  for (const event of ordered) {
    if (event.type !== "amazon_order_reconciled") continue;
    const { id, ...action } = event;
    // Never move snapshotMetadata backwards to a recovered event's ID.
    store.dispatch({ ...action, recoveredEventId: id });
  }
  store.dispatch({ type: "amazon_orders_recovered" });
}
