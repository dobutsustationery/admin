<script lang="ts">
import { store } from "$lib/store";
import { Parser } from "@json2csv/plainjs";

let state = store.getState();

let itemKeys: string[] = [];
let csv = "";
$: if ($store) {
  state = store.getState();
  itemKeys = Object.keys(state.inventory.idToItem);
  const fields = [
    "janCode",
    "subtype",
    "description",
    "image",
    "hsCode",
    "qty",
    "pieces",
      "shipped",
  ];
  const parser = new Parser({ fields });
  const data = itemKeys.map((k) => state.inventory.idToItem[k]);
  console.log({ data });
  if (data.length > 0) {
    csv = parser.parse(data).toString();
    console.log({ itemKeys, csv });
  }
}
</script>

<pre>{csv}</pre>
