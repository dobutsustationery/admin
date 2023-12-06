<script lang="ts">
  import { goto } from "$app/navigation";
  import { firestore } from "$lib/firebase";
  import { collection, onSnapshot, query } from "firebase/firestore";
  import { store } from '$lib/store';
  import { new_order } from "$lib/inventory";

  interface OrderInfo {
    id: string;
    email: string;
    item: string;
    date: Date;
  }

  function updateOrderInfo() {
    const state = store.getState();
    const orderIds = Object.keys(state.inventory.orderIdToOrder);
    console.log('ORDER IDs ', orderIds)
    orderInfo = [];
    for (const id of orderIds) {
      const email = state.inventory.orderIdToOrder[id].email || "";
      const item = state.inventory.orderIdToOrder[id].product || "";
      const date = state.inventory.orderIdToOrder[id].date;
      orderInfo.push({id, email, item, date})
    }
    orderInfo.sort((a, b) => {
      return a.date.getTime() - b.date.getTime()
    });
  }

  $: if ($store) {
    updateOrderInfo();
  }
  let orderInfo: OrderInfo[] = [];
  const dobutsu = collection(firestore, "dobutsu");
  const unsub = onSnapshot(
    query(dobutsu),
    (querySnapshot) => {
      for (let change of querySnapshot.docChanges()) {
        let data = change.doc.data();
        if (data.payment !== undefined) {
          const id = data.order_response.id;
          const item = data.order_request?.cart[0].product;
          const email = data.payment?.payment_source?.paypal?.email_address;
          const dateStr = data.payment.purchase_units[0].payments.captures[0].create_time;
          const date = new Date(dateStr);
          const units = data.payment.purchase_units;
          console.log({ units, dateStr, pay: data.payment, data, email, item, id });
          const state = store.getState();
          if (state.inventory.orderIdToOrder[id].email === undefined) {
            store.dispatch(new_order({orderID: id, date, email, product: item}));
          }
        }
      }
    },
    (error) => {
      console.log("query failing: ");
      console.error(error);
    }
  );
  
  function formatDate(d: Date) {
    return d.toLocaleDateString('en-us', { weekday: "short", year:"numeric", month:"short", day:"numeric"}) 
  }

  function packOrder(id: string, email: string, product: string) {
    return () => {
        goto(`/order?orderId=${id}&email=${email}&product=${product}`);
    }
  }
</script>

<h1>Orders</h1>
<table>
    <tr><th>Date</th><th>ID</th><th>Email</th><th>Product</th></tr>
  {#each orderInfo as order}
    <tr on:click={packOrder(order.id, order.email, order.item)}>
      <td>{formatDate(order.date)}</td>
      <td>{order.id}</td><td>{order.email}</td><td>{order.item}</td></tr>
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
</style>
