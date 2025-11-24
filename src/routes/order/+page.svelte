<script lang="ts">
import { page } from "$app/stores";
import BarcodeScanner from "$lib/BarcodeScanner.svelte";
import OrderRow from "$lib/OrderRow.svelte";
import { firestore } from "$lib/firebase";
import { user } from "$lib/globals";
import {
  type LineItem,
  package_item,
  quantify_item,
  retype_item,
} from "$lib/inventory";
import { broadcast } from "$lib/redux-firestore";
import { store } from "$lib/store";

let state = store.getState();

$: orderID = $page.url.searchParams.get("orderId");
$: email = $page.url.searchParams.get("email");
$: product = $page.url.searchParams.get("product");

let orderItems: LineItem[] = [];
$: if ($store) {
  state = store.getState();
  if (
    orderID !== null &&
    state.inventory.orderIdToOrder[orderID] !== undefined
  ) {
    orderItems = state.inventory.orderIdToOrder[orderID]?.items;
  }
}

function barcode(e: CustomEvent) {
  let itemKey = e.detail;
  if (state.inventory.idToItem[itemKey] === undefined) {
    const allKeys = Object.keys(state.inventory.idToItem);
    const possibleKeys = allKeys.filter((k) => k.startsWith(itemKey));
    if (possibleKeys.length > 0) {
      itemKey = possibleKeys[0];
    }
  }
  if (state.inventory.idToItem[itemKey] && orderID !== null) {
    const qty = 1;
    broadcast(firestore, $user.uid, package_item({ orderID, itemKey, qty }));
  }
}
function snapshot() {
  console.log("new snapshot?!");
}

function updateQuantity(itemKey: string) {
  return (e: CustomEvent) => {
    const qty = +e.detail;
    if (state.inventory.idToItem[itemKey] && orderID !== null) {
      broadcast(firestore, $user.uid, quantify_item({ orderID, itemKey, qty }));
    }
  };
}
function updateSubtype(lineItem: LineItem) {
  return (e: CustomEvent) => {
    const subtype = e.detail as string;
    const itemKey = lineItem.itemKey;
    const qty = lineItem.qty;
    if (state.inventory.idToItem[itemKey] && orderID !== null) {
      const janCode = state.inventory.idToItem[itemKey].janCode;
      broadcast(
        firestore,
        $user.uid,
        retype_item({ orderID, itemKey, subtype, qty, janCode }),
      );
    }
  };
}
$: orderItemsR = [...orderItems].reverse();
</script>

<BarcodeScanner on:barcode={barcode} on:snapshot={snapshot} />
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
  {#each orderItemsR as k , i (k.itemKey)}
    <OrderRow
      key={k.itemKey}
      row={i}
      qty={k.qty}
      on:qty={updateQuantity(k.itemKey)}
      on:subtype={updateSubtype(k)}
    />
  {/each}
</table>
