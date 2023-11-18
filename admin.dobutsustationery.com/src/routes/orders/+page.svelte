<script lang="ts">
  import { goto } from "$app/navigation";
  import { firestore } from "$lib/firebase";
  import { collection, onSnapshot, orderBy, query } from "firebase/firestore";

  interface OrderInfo {
    id: string;
    email: string;
    item: string;
  }
  let orders: OrderInfo[] = [];
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
          console.log({ pay: data.payment, data, email, item, id });
          orders.push({ id, email, item });
        }
        orders = orders;
      }
    },
    (error) => {
      console.log("query failing: ");
      console.error(error);
    }
  );

  function packOrder(id: string, email: string, product: string) {
    return () => {
        goto(`/order?orderId=${id}&email=${email}&product=${product}`);
    }
  }
</script>

<h1>Orders</h1>
<table>
    <tr><th>ID</th><th>Email</th><th>Product</th></tr>
  {#each orders as order}
    <tr on:click={packOrder(order.id, order.email, order.item)}><td>{order.id}</td><td>{order.email}</td><td>{order.item}</td></tr>
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
