<script lang="ts">
  import {
    collection,
    doc,
    writeBatch,
    serverTimestamp,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { preparationScope } from "$lib/amazon-preparation";
  import { categoryMapping } from "$lib/amazon-defaults";
  import {
    amazonProductFacts,
    amazonFactFields,
    amazonFactLabels,
    type AmazonProductFacts,
  } from "$lib/amazon-product-attributes";
  export let handle: string;
  let editing = false,
    busy = false,
    error = "",
    message = "";
  let values: Record<string, AmazonProductFacts> = {};
  $: seller = $store.amazonAudit?.sellerId || "";
  $: listing = $store.listings.handleToListing[handle];
  $: type = categoryMapping(
    $store.amazonPreparation,
    seller,
    listing?.productCategory || "",
  ).productType;
  $: fields = amazonFactFields(type);
  $: items = (
    Object.entries($store.inventory.idToItem) as [string, any][]
  ).filter(
    ([key, item]: [string, any]) =>
      ($store.listings.idToHandle[key] || item.handle) === handle,
  );
  function edit() {
    values = Object.fromEntries(
      items.map(([key, item]) => [
        key,
        amazonProductFacts(
          item,
          listing,
          $store.amazonPreparation?.decisions?.[preparationScope(seller, key)]
            ?.productFacts,
        ),
      ]),
    );
    editing = true;
    error = "";
    message = "";
  }
  function change(key: string, field: keyof AmazonProductFacts, value: string) {
    values = {
      ...values,
      [key]: {
        ...values[key],
        [field]:
          field === "material" || field === "inkBase" || field === "warranty"
            ? value
            : value === ""
              ? undefined
              : Number(value),
      },
    };
  }
  async function save() {
    busy = true;
    error = "";
    try {
      if (!$user) throw Error("Sign in to save product details.");
      const batch = writeBatch(firestore);
      for (const [key] of items) {
        for (const [field, value] of Object.entries(values[key]))
          if (
            typeof value === "number" &&
            (!Number.isFinite(value) || value <= 0)
          )
            throw Error(
              `${amazonFactLabels[field as keyof AmazonProductFacts]} must be a positive number.`,
            );
        batch.set(doc(collection(firestore, "broadcast")), {
          type: "amazonPrepare/decision",
          creator: $user.uid,
          timestamp: serverTimestamp(),
          payload: {
            sellerId: seller,
            itemKey: key,
            decision: {
              productFacts: Object.fromEntries(
                Object.entries(values[key]).filter(
                  ([, v]) => v !== undefined && v !== "",
                ),
              ),
            },
          },
        });
      }
      await batch.commit();
      editing = false;
      message = "Amazon product details saved. Sync listing to submit them.";
    } catch (e: any) {
      error = e.message;
    } finally {
      busy = false;
    }
  }
</script>

{#if fields.length}
  <div class="product-facts">
    <button on:click={edit}>Edit Amazon product details</button>
    {#if editing}
      <p>
        Supplier specifications are filled in where recorded. Enter missing
        measurements or ink facts here; these do not change inventory quantities
        or source photos.
      </p>
      {#each items as [key, item]}
        <fieldset>
          <legend>{item.subtype || key} · {key}</legend>
          {#each fields as field}
            <label
              >{amazonFactLabels[field]}
              {#if field === "inkBase"}
                <select
                  value={values[key]?.[field] || ""}
                  on:change={(e) => change(key, field, e.currentTarget.value)}
                >
                  <option value="">Select ink base</option>
                  {#each ["no_ink", "water", "oil", "alcohol", "pigment", "hybrid"] as ink}<option
                      value={ink}>{ink.replace("_", " ")}</option
                    >{/each}
                </select>
              {:else}
                <input
                  type={field === "material" || field === "warranty"
                    ? "text"
                    : "number"}
                  min="0.001"
                  step="any"
                  value={values[key]?.[field] ?? ""}
                  on:input={(e) => change(key, field, e.currentTarget.value)}
                />
              {/if}
            </label>
          {/each}
        </fieldset>
      {/each}
      <button disabled={busy} on:click={save}
        >Save Amazon product details</button
      >
      <button disabled={busy} on:click={() => (editing = false)}>Cancel</button>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    {#if message}<p role="status">{message}</p>{/if}
  </div>
{/if}

<style>
  .product-facts {
    margin: 0.5rem 0;
  }
  fieldset {
    border: 1px solid #cbd5e1;
    margin: 0.5rem 0;
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  input,
  select,
  button {
    padding: 0.5rem;
    border: 1px solid #9ca3af;
    border-radius: 5px;
  }
  button {
    margin-right: 0.5rem;
    cursor: pointer;
  }
</style>
