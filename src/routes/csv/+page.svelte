<script lang="ts">
import { Parser } from "@json2csv/plainjs";
import { store } from "$lib/store";

let state = store.getState();

let itemKeys: string[] = [];
let csv: string = "";
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
