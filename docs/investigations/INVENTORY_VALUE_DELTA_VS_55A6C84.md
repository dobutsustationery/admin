# Inventory-Value Timeline: staging (`a402baa`) vs `55a6c84`

Generated 2026-06-17. Explains every historical inventory-value mismatch the
accountant's `/inventory-value` route shows between **current staging**
(commit `a402baa`, "Move uncosted creation remainder forward on zeroed-order
restock") and the pre-cost-ledger-rework baseline **`55a6c84`** ("Improve
Shopify listing mismatch review").

## Methodology (and why an earlier reproduction was wrong)

Each side's timeline must be computed with **that side's own code**, because the
report's `Value` column calls `cost-engine`'s valuation walk, and `cost-engine`
changed by +288 lines between `55a6c84` and `a402baa` (`inventory-value.ts`
itself is unchanged). Applying current code to the old ledger gives numbers that
*look* consistent for cumulative-received but diverge wildly on `Value`.

- **Staging** = `a402baa` code, replayed over the June 11 backup **plus the four
  post-reset staging actions** (2 auto-resynced Shopify reconciliations, the
  Green un-ignore `iwse9HP5`, the Beige induce `8wkjSfl3`) — 41,775 docs, exactly
  matching live staging.
- **Baseline** = `55a6c84` code, replayed over the **plain** June 11 backup
  (41,771 docs — none of the staging-only actions).

Both run through `buildInventoryValueReport`. The reproduced deltas match the
accountant's TSV to the yen (e.g. `+4,550` cum-inv at 2024-07-02, `+3,310` value
at 2024-10-31, `−628` sold at 2025-05-31, `−3,235` sold at current).

**Convention below:** the TSV reports **baseline − staging**, so a *positive*
number means `55a6c84` valued it higher than staging. Per-JAN figures here are
quoted as **staging − baseline** (the negation) and aggregated by JAN, which
cancels the `ea5f468` single-variant key migration (bare-JAN vs subtyped keys
net to zero per JAN and are pure display noise — not value movement).

## The three columns

- **Value** = on-hand inventory value at the date (`cost-engine` valuation walk).
- **Cumulative Inventory Value** = cumulative cost of *all lots ever received*.
- **Cumulative Sold Value** = cumulative COGS.

## Timeline of mismatches

| Date / event | Δ Value (JPY) | Δ Cum-Inv (JPY) | Δ Sold (JPY) | Driver |
|---|---:|---:|---:|---|
| 2024-07-02 Amifa Order 2 received | +4,290 | +4,550 | 0 | order-date vs scan-date attribution |
| 2024-07-31 → 2024-09-30 | ~+4,258 | +4,550 | ~+32 | early Amifa sales |
| 2024-10-31 (after 2024-10-09 scans) | −3,310 | **0** | +154 | zero-cost-merge re-pricing |
| 2025-05-31 Japan Festival archive | +4,080 | 0 | −628 | archive-sweep re-derivation |
| 2025-07-31 onward | +4,340 | 0 | −878 | …compounding COGS |
| 2026-06-15 Current | +6,717 | 0 | −3,235 | archive + retype COGS + 2 staging orders |

*(table in the accountant's `baseline − staging` sign.)*

### 1 · 2024-07-02 — Amifa Order 2 booked later on staging (cum-inv +4,550)

At the order date, `55a6c84` already shows ¥4,550 of Amifa Order 2 inventory
that staging has **not yet booked**. Amifa Order 2 is a "zeroed-quantities"
order: its goods were created at ¥0 before the cost was known, and the cost is
attached later by the zeroed-order matcher. On `55a6c84` the matched lots land
at/near the **order date (2024-07-02)**; on staging the cost-ledger rework
(`26b788f` cost-ledger-authoritative, `e9d602d` retype-as-sales, `a402baa`
move-uncosted-forward) re-dates the cost-bearing receipts to the **2024-10-09
scan dates**, so they are invisible at 2024-07-02.

Per-JAN (staging − baseline), all Amifa Order 2 family:

| JAN | Item | Δ Cum-Inv |
|---|---|---:|
| 4542804113693 | Amifa Kawaii Pattern Masking Sheet (8) | −1,950 (30×¥65) |
| 4542804109153 | Amifa Panda Envelopes | −1,560 (24×¥65) |
| 4542804089301 | Amifa Wrapping Stickers Clear (20) | −780 (12×¥65) |
| 4542804108644 | Amifa Literary Kawaii Decoration Stickers (34) | −520 |
| 4542804108637 | Amifa Pétale Clear Floral Stickers (30) | +520 |

This is purely a **timing** difference — it fully resolves by 2024-10-31.

### 2 · 2024-10-31 — received converges, on-hand value diverges (value −3,310)

Once the 2024-10-09 scans are booked on both sides, cumulative received is
**identical** (Δ cum-inv = 0) — the *total* Amifa cost is the same; only the
date it landed differed. But staging now values on-hand stock **¥3,310 higher**,
because the **zero-cost-merge re-pricing** (`234290f` "Adopt incoming cost for
uncosted on-hand") lifts the ¥0 creation lots to their true ¥65 basis, whereas
`55a6c84` leaves them ¥0 or blends them down.

Per-JAN (staging − baseline): 4542804114232 Twinkle Bloom +1,301 · 4542804109153
Panda +482 · 4542804080872 Clear Sticker Flakes +465 · 4542804108606 Animal
Family +390 · 4542804112832 Fruit Mini Card +260 · 4542804108637 Pétale +260.

### 3 · 2025-05-31 — Japan Festival archive sweeps more to COGS (sold −628, value +4,080)

The April-2025 Japan Festival archive replays in May 2025. Staging's
**archive-sweep re-derivation** (`26cee8a` "Re-derive archive sale sweep from the
current ledger", `ef037b1` empty-item marker) sweeps the *re-derived* on-hand to
COGS at archive time — consuming more, leaving less on hand. `55a6c84` used the
frozen archive snapshot, sweeping less.

Dominant driver:

| JAN | Item | Δ Value | Δ Sold |
|---|---|---:|---:|
| 4902778185650 | Mitsubishi Kurotoga Pencil 0.7mm Blue | −2,827 | +2,827 |
| 4542804112917 | Amifa Origami Paper — Sakura | −715 | +715 |
| 4952270242597 | Furukawa Hedgehog Sticky Notes | −212 | +212 |
| 4952270287086 | Furukawa Neko Cat Stationery | −194 | +194 |
| 4977564720711 | (Furukawa) | −178 | +178 |

`4902778185650` is the item examined earlier in this work (20 arrived, all sold):
staging's sweep books the full COGS and zeroes on-hand; `55a6c84` reconstructs a
residual on-hand and under-books COGS.

### 4 · 2026-06-15 Current — cumulative COGS gap widens (sold −3,235, value +6,717)

The current gap is the running sum of the archive effect plus later sales booked
at staging's (different) cost basis — the cost-ledger-authoritative quantities,
the retype-as-sales COGS attribution, and the archive carry — **plus the two
Sept-2025 Shopify orders** (#1039/#1040) that exist on staging (the re-synced
`shopify_order_reconciled` actions) but not in the plain baseline. Those orders
sell pens/markers that the baseline never consumes, so staging shows extra COGS:

| JAN | Item | Δ Value | Δ Sold | Note |
|---|---|---:|---:|---|
| 4902778185650 | Mitsubishi Kurotoga Pencil | −2,827 | +2,827 | archive (carried from §3) |
| 4902505523915 | Pilot Juice Up Pastel Pens | −720 | +720 | order #1039 |
| 4542804112917 | Amifa Origami — Sakura | −715 | +715 | archive |
| 4901681382316 | Zebra Clickart Marker Set | −636 | +636 | order #1039 |
| 4902778692417 | Uni Propus Highlighter Set | −270 | +270 | order #1039 |
| 4901681867424 | Zebra Sarasa Clip Gel Pens | −265 | +265 | order #1039 |
| 4542804112832 | Amifa Fruit Mini Card Set | −260 | +314 | retype/recount |

36 JANs differ in total at current.

## Mechanism summary — what changed between `55a6c84` and `a402baa`

| Mechanism | Commit(s) | Timeline effect |
|---|---|---|
| Zeroed-order cost re-dated to scan dates | `26b788f`, `e9d602d`, `a402baa` | 2024-07-02 cum-inv −4,550 (timing only; resolves) |
| Zero-cost-merge re-pricing (¥0 → ¥65) | `234290f`, `eea96a9` | 2024-10-31 on-hand value +3,310 (staging higher) |
| Archive-sweep re-derivation | `26cee8a`, `ef037b1`, `646105b` | 2025-05 onward COGS higher / on-hand lower |
| Retype recorded as cost-ledger sales | `e9d602d` | per-subtype COGS re-attribution over time |
| Single-variant key migration | `ea5f468` | **none** (bare/subtyped net to zero per JAN — display only) |
| Oversold detection | `cd3e4e5`…`808c132` | **none** (read-only; no replayed-state change) |
| 2 re-synced Shopify orders (#1039/#1040) | staging data, not code | extra COGS at current (data difference, not a code delta) |

## Reading guidance

- The **cum-inv** difference is **purely timing** and self-heals by 2024-10-31 —
  total received cost is identical on both branches.
- The **on-hand value** difference (staging higher from 2024-10-31) is the
  **intended correction**: ¥0 uncosted stock now carries its true ¥65 basis.
- The growing **sold/COGS** difference is the archive-sweep re-derivation
  recognizing COGS that `55a6c84` deferred, plus the two staging-only orders.
- None of the deltas come from the key migration or oversold surfacing.
