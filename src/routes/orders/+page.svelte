<script lang="ts">
  import { collection, onSnapshot, query } from "firebase/firestore";
  import { goto } from "$app/navigation";
  import { firestore } from "$lib/firebase";
  import {
    getOrderDisplayStatus,
    new_order,
    type OrderDisplayStatus,
    type UnmatchedOrderLine,
  } from "$lib/inventory";
  import { store } from "$lib/store";

  interface OrderInfo {
    id: string;
    email: string;
    item: string;
    date: Date;
    eventDate?: Date;
    status?: string;
    displayStatus: OrderDisplayStatus;
    exceptionCount: number;
    exceptionSummary: string;
  }

  function updateOrderInfo() {
    const state = store.getState();
    const orderIds = Object.keys(state.inventory.orderIdToOrder);
    orderInfo = [];
    for (const id of orderIds) {
      const order = state.inventory.orderIdToOrder[id];
      const email = order.email || "";
      const item = order.product || "";
      const date = order.date;
      const eventDate = order.eventDate;
      const status = order.status;
      const displayStatus = getOrderDisplayStatus(order);
      const unmatchedLines: UnmatchedOrderLine[] = order.unmatchedLines || [];
      const exceptionMessages = [
        ...(state.inventory.shopifyExceptions?.[id] || []),
        ...(state.inventory.etsyExceptions?.[id] || []),
      ];
      const exceptionSummary = [
        ...unmatchedLines.map(
          (line) =>
            `${line.reason}: ${line.sku || "(blank SKU)"} x${line.quantity}`,
        ),
        ...exceptionMessages,
      ].join("\n");
      orderInfo.push({
        id,
        email,
        item,
        date,
        eventDate,
        status,
        displayStatus,
        exceptionCount: unmatchedLines.length + exceptionMessages.length,
        exceptionSummary,
      });
    }
    orderInfo.sort((a, b) => {
      const aPrimary = (a.eventDate ?? a.date).getTime();
      const bPrimary = (b.eventDate ?? b.date).getTime();
      return bPrimary - aPrimary;
    });
  }

  const STATUS_LABEL: Record<OrderDisplayStatus, string> = {
    ok: "",
    canceled: "Canceled",
    refunded: "Refunded",
    partial_refund: "Partial refund",
    unpaid: "Unpaid",
  };

  $: if ($store) {
    updateOrderInfo();
  }
  let orderInfo: OrderInfo[] = [];
  const dobutsu = collection(firestore, "dobutsu");
  const unsub = onSnapshot(
    query(dobutsu),
    (querySnapshot) => {
      for (const change of querySnapshot.docChanges()) {
        const data = change.doc.data();
        if (data.payment !== undefined) {
          const id = data.order_response.id;
          const item = data.order_request?.cart[0].product;
          const email = data.payment?.payment_source?.paypal?.email_address;
          const dateStr =
            data.payment.purchase_units[0].payments.captures[0].create_time;
          const date = new Date(dateStr);
          const units = data.payment.purchase_units;
          const state = store.getState();
          if (state.inventory.orderIdToOrder[id]?.email === undefined) {
            store.dispatch(
              new_order({ orderID: id, date, email, product: item }),
            );
          }
        }
      }
    },
    (error) => {
      console.log("query failing: ");
      console.error(error);
    },
  );

  function formatDate(d: Date) {
    return d.toLocaleDateString("en-us", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function packOrder(id: string, email: string, product: string) {
    return () => {
      goto(`/order?orderId=${id}&email=${email}&product=${product}`);
    };
  }
</script>

<h1>Orders</h1>
<table>
  <tr
    ><th>Order Date</th><th>Entered</th><th>ID</th><th>Status</th><th>Email</th
    ><th>Product</th></tr
  >
  {#each orderInfo as order}
    <tr
      class:row-canceled={order.displayStatus === "canceled"}
      class:row-refunded={order.displayStatus === "refunded" ||
        order.displayStatus === "partial_refund"}
      class:row-unpaid={order.displayStatus === "unpaid"}
      class:row-exception={order.exceptionCount > 0}
      on:click={packOrder(order.id, order.email, order.item)}
    >
      <td>{formatDate(order.eventDate ?? order.date)}</td>
      <td class="entered">{formatDate(order.date)}</td>
      <td>{order.id}</td>
      <td>
        {#if order.displayStatus !== "ok"}
          <span class="badge {order.displayStatus}"
            >{STATUS_LABEL[order.displayStatus]}</span
          >
        {/if}
        {#if order.exceptionCount > 0}
          <span class="badge exception" title={order.exceptionSummary}
            >{order.exceptionCount} Missing</span
          >
        {/if}
      </td>
      <td>{order.email}</td><td>{order.item}</td></tr
    >
  {/each}
</table>

<style>
  tr:hover {
    background-color: antiquewhite;
  }
  th {
    text-align: left;
    padding: 0.2em;
  }

  td {
    padding: 0.2em;
  }

  td.entered {
    color: #58606f;
    font-size: 0.9em;
  }

  .row-canceled td {
    color: #8b1a1a;
    text-decoration: line-through;
  }
  .row-refunded td {
    color: #6b4a00;
  }
  .row-unpaid td {
    color: #4a3a8b;
  }
  .row-exception td {
    background: #fff8e5;
  }

  .badge {
    display: inline-block;
    padding: 0.1em 0.5em;
    border-radius: 4px;
    font-size: 0.78em;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    text-decoration: none;
  }
  .badge.canceled {
    background: #fdecec;
    color: #8b1a1a;
    border: 1px solid #f1b9b9;
  }
  .badge.refunded,
  .badge.partial_refund {
    background: #fff5d6;
    color: #6b4a00;
    border: 1px solid #ecd07a;
  }
  .badge.unpaid {
    background: #ecebfd;
    color: #4a3a8b;
    border: 1px solid #c3bff0;
  }
  .badge.exception {
    background: #fdecec;
    color: #8b1a1a;
    border: 1px solid #f1b9b9;
  }
</style>
