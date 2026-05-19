<script lang="ts">
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import { walkLedger, type LedgerEntry } from "$lib/cost-engine";
  import type { Item } from "$lib/inventory";

  // Compact-yet-complete snapshot of an item's current state. Pure
  // presentation: pass the resolved item, its key, and (optionally) its
  // cost ledger so the card can show the derived weighted-average cost.
  export let item: Item | null;
  export let itemKey: string;
  export let ledger: LedgerEntry[] = [];

  // Avg cost is per-JAN (stock orders have no subtype) so the ledger
  // walk is correct for it. On-hand, however, is this specific
  // subtype's qty − shipped — the ledger sums lots across subtypes.
  $: cost = ledger.length ? walkLedger(ledger) : null;
  $: receiptLots = ledger.filter((e) => e.kind === "receipt").length;
  $: onHand = item ? Math.max(0, (item.qty || 0) - (item.shipped || 0)) : 0;

  const yen = (n: number | undefined | null) =>
    n == null || !Number.isFinite(n)
      ? "—"
      : `¥${Math.round(n).toLocaleString()}`;
  const eur = (n: number | undefined | null) =>
    n == null || !Number.isFinite(n) || n === 0 ? "—" : `€${n.toFixed(2)}`;
  const num = (n: number | undefined | null) =>
    n == null || !Number.isFinite(n) ? "—" : n.toLocaleString();
  const txt = (s: string | undefined | null) =>
    s == null || String(s).trim() === "" ? "—" : String(s);
</script>

<div class="card">
  <div class="head">
    <div class="thumb">
      {#if item?.image}
        <ImageThumbnail
          src={item.image}
          alt={item.description}
          width="96px"
          height="96px"
        />
      {:else}
        <div class="noimg">no image</div>
      {/if}
    </div>
    <div class="ident">
      <h2 class="desc">{txt(item?.description)}</h2>
      <div class="codes">
        <span class="jan">{txt(item?.janCode)}</span>
        {#if item?.subtype}<span class="subtype">{item.subtype}</span>{/if}
        <span class="key" title="inventory key">{itemKey}</span>
      </div>
      {#if item?.handle}
        <div class="handle">
          shopify:
          <a href={`/listing-detail?handle=${encodeURIComponent(item.handle)}`}
            >{item.handle}</a
          >
        </div>
      {:else}
        <div class="handle muted">not on shopify</div>
      {/if}
    </div>
  </div>

  {#if !item}
    <p class="missing">Not present in current inventory.</p>
  {:else}
    <div class="groups">
      <section>
        <h3>Stock</h3>
        <dl>
          <dt>On hand</dt>
          <dd>{onHand}/{num(item.qty)}</dd>
          <dt>Value €</dt>
          <dd>{cost ? eur(onHand * cost.avgEur) : "—"}</dd>
          <dt>Cost lots</dt>
          <dd>{receiptLots || "—"}</dd>
        </dl>
      </section>

      <section>
        <h3>Cost &amp; price</h3>
        <dl>
          <dt>Price</dt>
          <dd>{eur(item.price)}</dd>
          <dt>Avg cost ¥</dt>
          <dd>{cost ? yen(cost.avgJpy) : "—"}</dd>
          <dt>Avg cost €</dt>
          <dd>{cost ? eur(cost.avgEur) : "—"}</dd>
        </dl>
      </section>

      <section>
        <h3>Attributes</h3>
        <dl>
          <dt>HS code</dt>
          <dd>{txt(item.hsCode)}</dd>
          <dt>Origin</dt>
          <dd>{txt(item.countryOfOrigin)}</dd>
          <dt>Weight</dt>
          <dd>{item.weight && item.weight > 0 ? `${item.weight} g` : "—"}</dd>
        </dl>
      </section>
    </div>
  {/if}
</div>

<style>
  .card {
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    background: #fff;
    padding: 1rem 1.25rem;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  }
  .head {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }
  .thumb {
    flex-shrink: 0;
    width: 96px;
    height: 96px;
  }
  .noimg {
    width: 96px;
    height: 96px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f3f4f6;
    color: #9ca3af;
    font-size: 0.7rem;
    border-radius: 4px;
  }
  .ident {
    min-width: 0;
    flex: 1;
  }
  .desc {
    margin: 0 0 0.35rem;
    font-size: 1.15rem;
    line-height: 1.3;
    color: #111827;
  }
  .codes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    font-family: ui-monospace, Menlo, monospace;
    font-size: 0.85rem;
  }
  .jan {
    font-weight: 700;
  }
  .subtype {
    background: #eef2ff;
    color: #4338ca;
    padding: 0.05rem 0.4rem;
    border-radius: 4px;
  }
  .key {
    color: #6b7280;
  }
  .handle {
    margin-top: 0.35rem;
    font-size: 0.8rem;
    color: #047857;
  }
  .handle a {
    color: #047857;
    font-weight: 600;
  }
  .handle.muted {
    color: #9ca3af;
  }
  .missing {
    margin: 1rem 0 0;
    color: #b91c1c;
    font-size: 0.9rem;
  }
  .groups {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 0.75rem 1.5rem;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid #f0f0f0;
  }
  section h3 {
    margin: 0 0 0.4rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
  }
  dl {
    margin: 0;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.15rem 0.75rem;
  }
  dt {
    color: #6b7280;
    font-size: 0.82rem;
  }
  dd {
    margin: 0;
    text-align: right;
    font-size: 0.82rem;
    color: #111827;
    font-variant-numeric: tabular-nums;
  }
</style>
