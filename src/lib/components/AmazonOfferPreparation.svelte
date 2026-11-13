<script lang="ts">
  import {
    collection,
    doc,
    serverTimestamp,
    writeBatch,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { projectAmazonOfferRows } from "$lib/amazon-sync-plan";
  import { findAmazonOfferMatches } from "$lib/amazon-offer-requests";
  import ImageThumbnail from "./ImageThumbnail.svelte";
  export let handles: string[] = [];
  let choices: Record<
    string,
    { asin: string; asinVerified: boolean; priceGBP: string; sku: string }
  > = {};
  let lookupIds: string[] = [];
  $: lookupError = lookupIds.includes($store.amazonCatalog?.lastFailedRequestId)
    ? $store.amazonCatalog.lastProbeError
    : "";
  let busy = false,
    error = "",
    message = "";
  $: rows = projectAmazonOfferRows($store).filter((r) =>
    handles.includes(r.row.family),
  );
  $: for (const r of rows) {
    if (!choices[r.row.key])
      choices = {
        ...choices,
        [r.row.key]: {
          asin:
            r.decision.asin ||
            r.row.asin ||
            (r.offerMatch?.candidates.length === 1
              ? r.offerMatch.candidates[0].asin
              : ""),
          asinVerified: r.decision.asinVerified === true,
          priceGBP: r.decision.priceGBP || "",
          sku: r.row.sku || "",
        },
      };
  }
  function change(key: string, patch: Partial<(typeof choices)[string]>) {
    choices = { ...choices, [key]: { ...choices[key], ...patch } };
  }
  async function find() {
    if (!$user?.uid) return;
    busy = true;
    error = "";
    message = "";
    try {
      const result = await findAmazonOfferMatches(
        firestore,
        $user.uid,
        rows.map((r) => r.row.jan),
      );
      lookupIds = [...lookupIds, ...result.requestIds];
      message = `Searching ${result.count} barcode(s) on the server. Matches appear here as results arrive.`;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
  async function save() {
    if (!$user?.uid) return;
    busy = true;
    error = "";
    message = "";
    try {
      const sellerId = $store.amazonAudit.sellerId;
      const writes: { ref: ReturnType<typeof doc>; data: any }[] = [];
      const batch = {
        set: (ref: ReturnType<typeof doc>, data: any) =>
          writes.push({ ref, data }),
      };
      const skus: string[] = [];
      for (const r of rows) {
        const choice = choices[r.row.key],
          asin = choice.asin.trim().toUpperCase();
        if (asin && !/^[A-Z0-9]{10}$/.test(asin))
          throw Error(
            `Enter a valid ASIN for ${r.row.subtype || r.row.title}.`,
          );
        if (
          choice.priceGBP &&
          (!/^\d+(\.\d{1,2})?$/.test(choice.priceGBP) ||
            !(Number(choice.priceGBP) > 0))
        )
          throw Error(
            "Enter a positive GBP price with at most two decimal places, or leave it blank for automatic pricing.",
          );
        batch.set(doc(collection(firestore, "broadcast")), {
          type: "amazonPrepare/decision",
          payload: {
            sellerId,
            itemKey: r.row.key,
            decision: {
              asin,
              asinVerified: !!asin && choice.asinVerified,
              priceGBP: choice.priceGBP,
            },
          },
          creator: $user.uid,
          timestamp: serverTimestamp(),
        });
        if (choice.sku.trim() !== r.row.sku) {
          batch.set(doc(collection(firestore, "broadcast")), {
            type: "amazonAudit/map",
            payload: {
              sellerId,
              marketplaceId: "A1F83G8C2ARO7P",
              itemKey: r.row.key,
              sku: choice.sku.trim(),
            },
            creator: $user.uid,
            timestamp: serverTimestamp(),
          });
          if (choice.sku.trim()) skus.push(choice.sku.trim());
        }
      }
      for (let i = 0; i < skus.length; i += 100)
        batch.set(doc(collection(firestore, "request_amazon_audit")), {
          creator: $user.uid,
          marketplaceId: "A1F83G8C2ARO7P",
          mode: "selected",
          skus: skus.slice(i, i + 100),
          createdAt: serverTimestamp(),
        });
      for (let i = 0; i < writes.length; i += 450) {
        const commit = writeBatch(firestore);
        for (const { ref, data } of writes.slice(i, i + 450))
          commit.set(ref, data);
        await commit.commit();
      }
      message =
        "Choices saved. Confirmed offers with stock and a price can now be synced from this screen.";
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="preparation" aria-label="Prepare existing Amazon offers">
  <p>
    Choose the existing Amazon product for each variant and check its pack size.
    Saving choices prepares the offers; Sync listing publishes them.
  </p>
  <button disabled={busy || !$user} on:click={find}>Find ASIN matches</button>
  {#each rows as r (r.row.key)}
    {@const choice = choices[r.row.key]}
    {@const candidate = r.offerMatch?.candidates.find(
      (c) => c.asin === choice?.asin,
    )}
    {#if choice}
      <fieldset>
        <legend
          >{r.row.title}
          {r.row.subtype} · JAN {r.row.jan} · {r.row.onHand} in stock</legend
        >
        <div class="photos">
          <div>
            <strong>Our product</strong><ImageThumbnail
              src={$store.inventory.idToItem[r.row.key]?.image ||
                $store.listings.handleToListing[r.row.family]?.images?.[0]
                  ?.url ||
                ""}
              width="140px"
              height="140px"
              fit="contain"
              alt={r.row.title}
            />
          </div>
          {#if candidate}<div>
              <strong>Amazon product</strong><ImageThumbnail
                src={candidate.image}
                width="140px"
                height="140px"
                fit="contain"
                alt={candidate.title}
              />
              <p>{candidate.title} · {candidate.brand}</p>
            </div>{/if}
        </div>
        {#if r.offerMatch?.error}<p role="alert">{r.offerMatch.error}</p>{/if}
        {#if r.offerMatch?.checked && !r.offerMatch.error && !r.offerMatch.candidates.length}<p
          >
            No ASIN matches were found for this barcode. You can enter an
            independently verified existing ASIN.
          </p>{/if}
        {#if r.offerMatch?.candidates.length}
          <label
            >Amazon match<select
              value={choice.asin}
              on:change={(e) =>
                change(r.row.key, {
                  asin: e.currentTarget.value,
                  asinVerified: false,
                })}
              ><option value="">Choose an exact match</option
              >{#each r.offerMatch.candidates as c}<option value={c.asin}
                  >{c.title} ({c.asin})</option
                >{/each}{#if choice.asin && !r.offerMatch.candidates.some((c) => c.asin === choice.asin)}<option
                  value={choice.asin}>{choice.asin}</option
                >{/if}</select
            ></label
          >
        {/if}
        <label
          >Existing ASIN<input
            value={choice.asin}
            maxlength="10"
            on:input={(e) =>
              change(r.row.key, {
                asin: e.currentTarget.value.toUpperCase(),
                asinVerified: false,
              })}
          /></label
        >
        {#if choice.asin}<a
            href={`https://www.amazon.co.uk/dp/${choice.asin}`}
            target="_blank"
            rel="noreferrer">Open Amazon product</a
          >{/if}
        <label
          ><input
            type="checkbox"
            checked={choice.asinVerified}
            disabled={!choice.asin}
            on:change={(e) =>
              change(r.row.key, { asinVerified: e.currentTarget.checked })}
          />I verified the ASIN matches this exact product, variant and pack
          size.</label
        >
        <label
          >GBP price override (optional)<input
            type="number"
            min="0.01"
            step="0.01"
            value={choice.priceGBP}
            on:input={(e) =>
              change(r.row.key, { priceGBP: e.currentTarget.value })}
          /></label
        >
        <p>
          Current offer price: GBP {r.price.toFixed(2)}. Leave the override
          blank to use the euro price and exchange rate.
        </p>
        <details>
          <summary>Link an existing seller SKU</summary><label
            >Verified existing Amazon seller SKU<input
              value={choice.sku}
              on:input={(e) =>
                change(r.row.key, { sku: e.currentTarget.value })}
            /></label
          >{#if r.row.skuCandidates.length}<p>
              Possible seller SKUs: {r.row.skuCandidates.join(", ")}
            </p>{/if}
        </details>
      </fieldset>
    {/if}
  {/each}
  <button disabled={busy || !$user} on:click={save}>Save offer choices</button>
  {#if lookupError}<p role="alert">{lookupError}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
</section>

<style>
  .preparation {
    background: #f4f7fb;
    padding: 1rem;
    margin: 1rem 0;
  }
  fieldset {
    margin: 1rem 0;
    border: 1px solid #bac8dc;
    padding: 1rem;
  }
  label {
    display: block;
    margin: 0.7rem 0;
  }
  input:not([type="checkbox"]),
  select {
    display: block;
    max-width: 100%;
    min-width: 15rem;
    padding: 0.4rem;
  }
  .photos {
    display: flex;
    flex-wrap: wrap;
    gap: 2rem;
  }
  .photos > div {
    max-width: 24rem;
  }
</style>
