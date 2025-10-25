<script lang="ts">
  import { goto } from "$app/navigation";
  import { firestore } from "$lib/firebase";
  import { collection, onSnapshot, query } from "firebase/firestore";
  import { store } from '$lib/store';
  import { new_order } from "$lib/inventory";

  interface PaymentInfo {
    id: string;
    email: string;
    item: string;
    date: Date;
  }

  let paymentInfo: PaymentInfo[] = [];
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
          const dateStr = data.payment.purchase_units[0].payments.captures[0].create_time;
          const date = new Date(dateStr);
          const units = data.payment.purchase_units;
          paymentInfo.push({id, email, item, date});
        } 
      }
      paymentInfo = [...paymentInfo].sort((d0, d1) => {
        return d0.date.getTime() - d1.date.getTime();
      });
    },
    (error) => {
      console.log("query failing: ");
      console.error(error);
    }
  );
  
  function formatDate(d: Date) {
    return d.toLocaleDateString('en-us', { weekday: "short", year:"numeric", month:"short", day:"numeric"}) 
  }
</script>

<h1>Payments</h1>
<table>
    <tr><th>Date</th><th>ID</th><th>Email</th><th>Product</th></tr>
  {#each paymentInfo as order}
    <tr>
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
