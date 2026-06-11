<script lang="ts">
  import { page } from "$app/stores";
  import BarcodeScanner from "$lib/BarcodeScanner.svelte";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/globals";
  import {
    getOrderDisplayStatus,
    type LineItem,
    type OrderDisplayStatus,
    type UnmatchedOrderLine,
    package_item,
    prepareCancelOrder,
    quantify_item,
    retype_item,
  } from "$lib/inventory";
  import { canonicalizeInventoryItemKey } from "$lib/sku";
  import OrderRow from "$lib/OrderRow.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import { store } from "$lib/store";

  let state = store.getState();

  $: orderID = $page.url.searchParams.get("orderId");
  $: email = $page.url.searchParams.get("email");
  $: product = $page.url.searchParams.get("product");

  let orderItems: LineItem[] = [];
  let unmatchedOrderLines: UnmatchedOrderLine[] = [];
  let orderStatusRaw = "";
  let displayStatus: OrderDisplayStatus = "ok";
  $: if ($store) {
    state = store.getState();
    if (
      orderID !== null &&
      state.inventory.orderIdToOrder[orderID] !== undefined
    ) {
      const order = state.inventory.orderIdToOrder[orderID];
      orderItems = order.items;
      unmatchedOrderLines = order.unmatchedLines || [];
      orderStatusRaw = order.status || "";
      displayStatus = getOrderDisplayStatus(order);
    } else {
      orderItems = [];
      unmatchedOrderLines = [];
      orderStatusRaw = "";
      displayStatus = "ok";
    }
  }

  const STATUS_LABEL: Record<OrderDisplayStatus, string> = {
    ok: "",
    canceled: "Canceled",
    refunded: "Refunded",
    partial_refund: "Partially refunded",
    unpaid: "Unpaid",
  };

  function barcode(e: CustomEvent) {
    let itemKey = e.detail;
    if (state.inventory.idToItem[itemKey] === undefined) {
      const allKeys = Object.keys(state.inventory.idToItem);
      const possibleKeys = allKeys.filter((k) => k.startsWith(itemKey));
      if (possibleKeys.length > 0) {
        itemKey = possibleKeys[0];
      }
    }
    const uid = $user?.uid;
    if (state.inventory.idToItem[itemKey] && orderID !== null && uid) {
      const qty = 1;
      broadcast(
        firestore,
        uid,
        package_item({
          orderID,
          itemKey: canonicalizeInventoryItemKey(itemKey),
          qty,
        }),
      );
    }
  }
  function snapshot() {
    console.log("new snapshot?!");
  }

  function updateQuantity(itemKey: string) {
    return (e: CustomEvent) => {
      const qty = +e.detail;
      const uid = $user?.uid;
      if (state.inventory.idToItem[itemKey] && orderID !== null && uid) {
        broadcast(
          firestore,
          uid,
          quantify_item({
            orderID,
            itemKey: canonicalizeInventoryItemKey(itemKey),
            qty,
          }),
        );
      }
    };
  }
  let cancelError = "";
  let cancelPending = false;

  async function cancelOrder() {
    cancelError = "";
    const uid = $user?.uid;
    if (!orderID) {
      cancelError = "No order id in the URL.";
      return;
    }
    if (!uid) {
      cancelError =
        "Not signed in. Reload the page once sign-in completes and try again.";
      return;
    }
    if (displayStatus === "canceled") return;
    const plan = prepareCancelOrder(orderID, uid, false);
    if (!plan) return;
    const ok = confirm(
      "Cancel this order?\n\nThis reverses the shipped quantity for every line item and marks the order Canceled. Refresh the marketplace side separately if needed.",
    );
    if (!ok) return;
    cancelPending = true;
    try {
      await broadcast(firestore, plan.uid, plan.action);
    } catch (e) {
      cancelError = "Failed to cancel order: " + (e as Error).message;
      console.error("Cancel order failed", e);
    } finally {
      cancelPending = false;
    }
  }
  function updateSubtype(lineItem: LineItem) {
    return (e: CustomEvent) => {
      const subtype = e.detail as string;
      const itemKey = lineItem.itemKey;
      const qty = lineItem.qty;
      const uid = $user?.uid;
      if (state.inventory.idToItem[itemKey] && orderID !== null && uid) {
        const janCode = state.inventory.idToItem[itemKey].janCode;
        broadcast(
          firestore,
          uid,
          retype_item({ orderID, itemKey, subtype, qty, janCode }),
        );
      }
    };
  }
  $: orderItemsR = [...orderItems].reverse();
</script>

<BarcodeScanner on:barcode={barcode} on:snapshot={snapshot} />
{#if displayStatus !== "ok"}
  <div class="status-banner {displayStatus}">
    <span class="status-label">{STATUS_LABEL[displayStatus]}</span>
    {#if orderStatusRaw && orderStatusRaw.toLowerCase() !== STATUS_LABEL[displayStatus].toLowerCase()}
      <span class="status-raw">({orderStatusRaw})</span>
    {/if}
    <span class="status-hint">
      {#if displayStatus === "canceled"}
        Do not pack or ship. Inventory impact has been reversed.
      {:else if displayStatus === "refunded"}
        Inventory impact has been reversed; do not ship.
      {:else if displayStatus === "partial_refund"}
        Refund recorded; verify before shipping.
      {:else if displayStatus === "unpaid"}
        Order is unpaid; do not pack until payment clears.
      {/if}
    </span>
  </div>
{/if}
<p>Order: {product} ({orderID}) for {email}</p>
<table>
  <thead
    ><tr>
      <th>Snapshot</th>
      <th>Description</th>
      <th>JAN Code</th>
      <th>Subtype</th>
      <th>Quantity</th>
    </tr></thead
  >
  {#each orderItemsR as k, i (k.itemKey)}
    <OrderRow
      key={k.itemKey}
      row={i}
      qty={k.qty}
      on:qty={updateQuantity(k.itemKey)}
      on:subtype={updateSubtype(k)}
    />
  {/each}
</table>

{#if unmatchedOrderLines.length > 0}
  <section class="unmatched-order-lines" aria-labelledby="unmatched-title">
    <h2 id="unmatched-title">Unmatched Items</h2>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Description</th>
          <th>SKU</th>
          <th>Reason</th>
          <th>Quantity</th>
          <th>Line Item</th>
        </tr>
      </thead>
      <tbody>
        {#each unmatchedOrderLines as line (`${line.source}:${line.lineId}:${line.sku}`)}
          <tr class="unmatched-row">
            <td>Missing</td>
            <td>{line.title || "(no title)"}</td>
            <td class="mono">{line.sku || "-"}</td>
            <td>{line.reason}</td>
            <td>{line.quantity}</td>
            <td class="mono">{line.lineId || "-"}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
{/if}

<button
  on:click={cancelOrder}
  disabled={displayStatus === "canceled" || cancelPending}
  class="cancel-button"
>
  {#if displayStatus === "canceled"}
    Order Canceled
  {:else if cancelPending}
    Cancelling…
  {:else}
    Cancel Order
  {/if}
</button>
{#if cancelError}
  <p class="cancel-error" role="alert">{cancelError}</p>
{/if}

<style>
  .status-banner {
    padding: 0.6em 1em;
    margin: 0.5em 0;
    border-radius: 6px;
    font-size: 1rem;
    display: flex;
    align-items: center;
    gap: 0.6em;
    flex-wrap: wrap;
  }
  .status-banner.canceled {
    background: #fdecec;
    color: #8b1a1a;
    border: 1px solid #f1b9b9;
  }
  .status-banner.refunded,
  .status-banner.partial_refund {
    background: #fff5d6;
    color: #6b4a00;
    border: 1px solid #ecd07a;
  }
  .status-banner.unpaid {
    background: #ecebfd;
    color: #4a3a8b;
    border: 1px solid #c3bff0;
  }
  .status-label {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .status-raw {
    font-family: ui-monospace, monospace;
    opacity: 0.7;
    font-size: 0.85em;
  }
  .status-hint {
    font-weight: 400;
  }

  .unmatched-order-lines {
    margin: 1em 0;
    padding: 0.75em;
    border: 1px solid #e1b866;
    background: #fff8e5;
    border-radius: 6px;
  }
  .unmatched-order-lines h2 {
    margin: 0 0 0.6em;
    font-size: 1.05rem;
  }
  .unmatched-order-lines table {
    width: 100%;
    border-collapse: collapse;
    background: #fffdf7;
  }
  .unmatched-order-lines th,
  .unmatched-order-lines td {
    padding: 0.45em 0.55em;
    border-bottom: 1px solid #f0dfb5;
    text-align: left;
    vertical-align: top;
  }
  .unmatched-row {
    color: #684100;
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 0.9em;
  }

  .cancel-button {
    margin-top: 1em;
    padding: 0.5em 1em;
    border: 1px solid #c89292;
    background: #fff5f5;
    color: #8b1a1a;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
  }
  .cancel-button:hover:not(:disabled) {
    background: #fdecec;
  }
  .cancel-button:disabled {
    color: #666;
    background: #eee;
    border-color: #ccc;
    cursor: not-allowed;
  }

  .cancel-error {
    margin-top: 0.5em;
    color: #8b1a1a;
    font-weight: 600;
  }
</style>
