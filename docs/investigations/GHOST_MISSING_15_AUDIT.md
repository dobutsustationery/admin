# Ghost-access "missing" rows — production audit (Apr 2026 backup)

## Scope

This investigation walks the 15 `keyAudit.ghostAccessEvents` rows with
`outcome = "missing"` produced by replaying the Apr 25 production
backup (`../production-backup-apr-25/firestore-export.json`,
24,799 broadcast actions) through the current `rootReducer`. The same
15 rows show in production's live audit page, so the replay is faithful.

For each row we record:

- the action that was effectively ignored,
- whether the realized state already reflects the user's intent (in which
  case the silent miss is harmless),
- what to check in the running inventory system to confirm the diagnosis.

Methodology and helper script: `scripts/audit-missing-15.ts`
(emits `/tmp/audit-missing-15.json` with full per-row JSON dumps).

Background on what `outcome=missing` means: the audit code only checks the
literal `requestedId` and its structural `canonicalCandidate` — it does
*not* consult `mappedCanonicalId`. A `missing` row therefore tells us
"the literal key carried by this action wasn't in `idToItem` at the time it
was processed." The action's intent might still have been realized by a
sibling action in the same burst, by canonicalization-on-write inside the
reducer, or might genuinely have been dropped.

## Summary of verdicts

| Verdict | Count | Rows |
|---|---:|---|
| Harmless — intent already realized or no-op | 8 | 1, 2, 3, 4, 5, 6, 8 (7 rows actually); see row-by-row |
| Real divergence — order vs `inventory.shipped` | 6 | 7, 9, 10, 11, 12, 13, 14 |
| Real data loss — qty edit lost | 1 | 15 |

(7 rows are harmless; 7 belong to two real shipped-count divergences on
two specific orders; 1 is a lost qty edit. Helen3 alone accounts for
5 of the 15 entries.)

## Row-by-row

### Row 1 — `update_item` `"4542804104370 Beige"` (whitespace-in-id typo)

- **When:** 2025-05-08 20:50:01 UTC
- **Ignored payload:**
  ```json
  {
    "id": "4542804104370 Beige",
    "item": {
      "janCode": "4542804104370 ", "subtype": "Beige",
      "description": "Design Paper Art Cards Literature",
      "hsCode": "39261000",
      "image": "https://cdn.getshifter.co/.../4542804104370.jpg",
      "qty": 5, "pieces": 0
    }
  }
  ```
- **Pre-state for JAN 4542804104370:** Brown(qty=0, hsCode=49090000),
  Cream(qty=0, hsCode=49090000). No Beige.
- **Final state for JAN 4542804104370:** Brown(qty=0, hsCode=49090000),
  Cream(qty=5, hsCode=39261000), **Beige(qty=5, hsCode=39261000)**.
- **Why it doesn't matter:** Today's `applyInventoryUpdate` (used by
  `update_item`) detects the JAN/subtype-vs-id mismatch and rewrites the id
  to its canonical form — `"4542804104370Beige"` — before writing. The
  audit observation only checks the literal payload id and the structural
  canonicalization, both of which were absent from `idToItem` at the
  pre-action moment, so the audit fired. The reducer still wrote the row.
  Beige is present in final state with the desired values.
- **What to check in the inventory system:** open the row for
  `4542804104370Beige` and confirm `qty = 5`, `hsCode = 39261000`,
  `description = "Design Paper Art Cards Literature"`, image as in
  payload. Spot-check Brown/Cream are also as expected — Cream's
  hsCode/qty changes you see in the trace come from later actions, not
  this one.

### Rows 2 — `update_field` for hsCode 4542804044119 Green → mapped Yellow

- **When:** 2025-05-11 15:45:25.184 UTC
- **Ignored payload:**
  ```json
  {"id":"4542804044119Green","field":"hsCode","to":"48114190","from":"48114120"}
  ```
- **Context:** Burst of 7 `update_field` actions in a single 310 ms
  window, from one client, on JAN `4542804044119`, all setting
  `hsCode 48114120 → 48114190`. Order in burst:
  Blue, Purple, Stripes, Multi abstract, Multi  checks, **Green**, Yellow.
  Only the Green one missed; the Yellow action immediately following
  (50 ms later) successfully updated the rename target.
- **Final state for JAN 4542804044119, hsCode column:** all six current
  subtypes (Blue, Purple, Stripes, "Multi abstract", "Multi  checks",
  Yellow) are at `"48114190"`.
- **Why it doesn't matter:** The user's intent for the rename target
  (Yellow) was satisfied by the *next* action in the same burst. Since
  Green was renamed away on 2025-05-03 and the user clearly wanted the
  same hsCode applied across the JAN's siblings, nothing useful was lost.
- **What to check:** confirm `4542804044119Yellow.hsCode === "48114190"`,
  and that no `4542804044119Green` row exists in inventory.

### Rows 3–6 — `update_field` for hsCode 4542804106312 Orange → mapped Yellow (×4)

- **When:** 2025-05-11 15:45:43, 15:45:55, 15:46:25, 15:46:28 UTC
- **Ignored payloads (all four):**
  Row 3: `from:"48114120", to:"48114190"`
  Rows 4, 5, 6: `from:"48114190", to:"48114190"` — identity updates.
  All target id `"4542804106312Orange"`, field `"hsCode"`.
- **Pre-state for JAN 4542804106312 (all four rows, identical):**
  Pink, Green, Brown, Yellow all already at `"48114190"`.
- **Final state:** unchanged from pre-state — all four siblings still at
  `"48114190"`.
- **Why it doesn't matter:**
  - Row 3 would have been a no-op against Yellow because Yellow was
    already at the target value before this action ran.
  - Rows 4–6 are *identity* updates (`from === to`), produced by the user
    re-clicking or repeatedly blurring the same field. Nothing would
    change even if applied.
- **What to check:** confirm `4542804106312Yellow.hsCode === "48114190"`
  and confirm no Orange row remains. Note the user's clearly retried
  the same edit four times — possibly a UI confusion worth a UX note,
  but no data action is required.

### Row 7 — `package_item` ghost on order `5XX72156AK696890X-2of3`

- **When:** 2025-05-29 09:24:22 UTC
- **Ignored payload:**
  ```json
  {"orderID":"5XX72156AK696890X-2of3","itemKey":"4542804130904Purple","qty":1}
  ```
- **Pre-state for JAN 4542804130904:** Unicorn(qty=22, shipped=0),
  Swan(qty=23, shipped=0). No Purple.
- **What still happened:** `package_item` unconditionally adds a line to
  `orderIdToOrder[orderID].items`, so the order picked up
  `{itemKey:"4542804130904Purple", qty:1}` as a "ghost line." The
  `state.idToItem[itemKey].shipped += qty` block is guarded by item
  existence, so Purple-the-item not existing meant **no shipped count
  was incremented anywhere**. Row 9 (below) later rewrites this ghost
  line to `Swan qty=1`.
- **Final state:** Unicorn(qty=22, **shipped=0**), Swan(qty=23,
  **shipped=0**); order `5XX72156AK696890X-2of3` has line
  `{4542804130904Swan, qty:1}`.
- **Why it matters:** The order claims one Swan went out, but
  `inventory.shipped[4542804130904Swan] = 0`. Effective inventory
  available calculations will overstate Swan by 1 unit. If the warehouse
  ever ships another item against this JAN/subtype, available counts
  will be off.
- **What to check:**
  - Look up order `5XX72156AK696890X-2of3` in the orders view; confirm a
    line for `4542804130904Swan, qty:1` is present.
  - Look at the `4542804130904Swan` row in inventory; confirm
    `shipped` reads `0` (or whatever the original baseline was) — i.e.
    inventory does *not* reflect this dispatched unit.
  - Sanity check warehouse / physical count against the declared 23 Swan
    units to see if 1 unit really went to that order.

### Row 8 — `rename_subtype` `4542804130904Pink → Pink` (self-rename)

- **When:** 2025-05-29 09:27:13 UTC
- **Ignored payload:**
  ```json
  {"itemKey":"4542804130904Pink","subtype":"Pink"}
  ```
- **Pre-state for JAN 4542804130904:** Unicorn(qty=22), Swan(qty=23).
  No Pink — Pink had been renamed to Swan long before.
- **Why it doesn't matter:** Identity rename (`Pink → Pink`). Even if
  applied, nothing would change. Likely a UI mis-click while user was
  tidying that order.
- **What to check:** nothing. Confirm there is no Pink subtype anywhere
  for this JAN.

### Row 9 — `retype_item` ghost on order `5XX72156AK696890X-2of3` (consequence of row 7)

- **When:** 2025-05-29 09:28:55 UTC
- **Ignored payload:**
  ```json
  {
    "orderID":"5XX72156AK696890X-2of3",
    "itemKey":"4542804130904Purple",
    "subtype":"Swan",
    "qty":1,
    "janCode":"4542804130904"
  }
  ```
- **Pre-state for JAN:** Unicorn(qty=22, shipped=0), Swan(qty=23,
  shipped=0); order has the `Purple qty=1` ghost line from row 7.
- **What still happened:** the order line was rewritten Purple→Swan
  successfully (line-rewrite path doesn't depend on `idToItem`). The
  shipped-counter rewrite (`-= qty` on Purple, `+= qty` on Swan) is
  guarded by *both* keys existing in `idToItem`; Purple didn't, so the
  whole shipped block was skipped.
- **Final state:** Unicorn(qty=22, **shipped=0**), Swan(qty=23,
  **shipped=0**). Order has `Swan qty=1`. Same divergence as row 7 —
  this is the *attempted fix* of row 7 that itself failed to reach
  inventory shipped counters.
- **Why it matters:** same as row 7. The retype put the order line on
  the right key but did not adjust shipped counts.
- **What to check:** as with row 7. Treating rows 7 and 9 as a single
  incident: order has 1 Swan, inventory says 0 Swans shipped. Net:
  remediate Swan's `shipped` by +1 against this order, or accept the
  state and adjust accordingly.

### Rows 10–14 — five-action burst on order `Helen3`, JAN `4542804112832` Orange (renamed → Cherry)

The `Helen3` order shows a sequence of five missing actions over a
~10-minute span on 2025-07-25, all referencing the renamed-away `Orange`
subtype. They are interleaved with non-failing actions on the same
order; the audit only marks five of them missing.

#### Row 10 — `package_item Orange qty=1` @ 12:58:44

- **Pre:** Strawberry(11,0), Cherry(10,0). No `Helen3` order yet.
- **Effect of the ignored action:** `Helen3` order created with line
  `{Orange qty=1}`. **No `idToItem.shipped` change** (Orange
  doesn't exist in `idToItem`).

#### Row 11 — `retype_item Orange → Strawberry qty=1` @ 12:59:04

- **Pre:** Strawberry(11,0), Cherry(10,0); order `Helen3` has
  `{Orange qty=1}`.
- **Effect:** order line rewritten from `Orange qty=1` to
  `Strawberry qty=1`. Shipped counters NOT adjusted (Orange missing →
  the both-exist guard fails).

#### Row 12 — `package_item Orange qty=1` @ 12:59:15 (second pkg)

- **Pre:** Strawberry(11,0), Cherry(10,0); order has `Strawberry qty=1`,
  plus an unrelated `4542804103519Purple qty=1` from another package.
- **Effect:** order picks up another `{Orange qty=1}` ghost line.
  No shipped change.

#### Row 13 — `quantify_item Orange qty=3` @ 12:59:23

- **Pre:** order has `Strawberry qty=1, 103519Purple qty=1, Orange qty=1`.
- **Effect:** Orange line bumped from 1 to 3 (or replaced — quantify
  semantics). Shipped untouched.

#### Row 14 — `retype_item Orange → Cherry qty=3` @ 13:08:27

- **Pre (after some unrelated activity):** Strawberry(11, **shipped=2**),
  Cherry(10, 0); order has `Strawberry qty=3` + `Orange qty=3`.
- **Effect:** order Orange line rewritten to `Cherry qty=3`. Shipped
  counters NOT adjusted (Orange missing).
- **Final order `Helen3`:** `Strawberry qty=3` + `Cherry qty=3` (six
  units). Other lines also present from unrelated actions.
- **Final inventory for JAN 4542804112832:**
  Strawberry(qty=11, shipped=2), Cherry(qty=10, shipped=0).

#### Why rows 10–14 matter (rolled up)

- The `Helen3` order claims **6 units** were dispatched against
  `4542804112832` (3 Strawberry + 3 Cherry).
- Inventory says only **2 units** were ever shipped on this JAN
  (Strawberry shipped=2, Cherry shipped=0).
- Net under-count: **4 units** against this JAN.
- "Available" = qty − shipped ⇒ Strawberry shows 9 available (real: 8),
  Cherry shows 10 available (real: 7). Future packs against either
  subtype will believe more stock exists than really does.

#### What to check (rows 10–14)

- Pull up order `Helen3` in the order view: confirm the lines include
  `4542804112832Strawberry qty=3` and `4542804112832Cherry qty=3` (and
  no Orange line).
- Pull up inventory rows `4542804112832Strawberry` and
  `4542804112832Cherry`. Confirm `shipped` reads `2` and `0`
  respectively; available reads `9` and `10`.
- Cross-check with physical / warehouse stock for these two subtypes —
  if real stock is 4 less than the system claims available, the
  divergence is exactly what's described above. A targeted
  `quantify_item` (or `package_item` if appropriate) replayed against
  the existing keys, today, can rebalance.

### Row 15 — `update_field` qty 24 → 12 on bare JAN `4542804123579`

- **When:** 2026-03-29 19:52:02 UTC
- **Ignored payload:**
  ```json
  {"id":"4542804123579","field":"qty","from":24,"to":12}
  ```
- **Pre-state for JAN 4542804123579:** only `4542804123579Transparent`
  exists, with `qty=24`. The bare-JAN row was renamed to `Transparent`
  in the past (ghost map records this rename: `mapped → Transparent`).
- **Final state:** `4542804123579Transparent.qty = 24` — **unchanged
  from pre-state.**
- **Why it matters:** the user clearly intended to halve on-hand qty
  (most likely after a stock-take recount) from 24 to 12. Because the
  payload still uses the bare-JAN id and Transparent's canonical key
  doesn't match by structural canonicalization, the action silently
  no-ops. The intended adjustment never reached inventory; the row
  still reports 24 units.
- **What to check:**
  - Inventory view: the row for `4542804123579Transparent` reads
    `qty = 24`.
  - Physical count or any other adjustment record for this product —
    if the real qty is 12 (or some other value), inventory is off by
    that amount today and a corrective `update_field` (using the
    canonical Transparent id) would fix it.

## Recommended remediation

Three of the shipped-counter divergences are eliminated by a single
reducer change (see "Reducer fix" below). After replaying the Apr 25
backup against the patched reducer, the three Swan/Strawberry/Cherry
counters land exactly on the values the audit recommends — no manual
broadcast actions needed for those three rows.

The remaining row (Transparent qty edit) is structurally different and
still requires a one-shot broadcast against the canonical key.

| Target | Subtype | Field | Fix delivered by |
|---|---|---|---|
| `4542804130904Swan` | Swan | `shipped` +1 (order `5XX72156AK696890X-2of3`) | **Reducer fix** (replays cleanly) |
| `4542804112832Strawberry` | Strawberry | `shipped` +1 (order `Helen3`) | **Reducer fix** (replays cleanly) |
| `4542804112832Cherry` | Cherry | `shipped` +3 (order `Helen3`) | **Reducer fix** (replays cleanly) |
| `4542804123579Transparent` | Transparent | `qty` → user-intended value (likely `12`) | One-shot `update_field` after stock-take |

The other 12 missing rows are noise — already-realized intent or
identity no-ops — and need no follow-up beyond UX nits (rows 4-6
re-fire suggests a stuck blur handler).

## Reducer fix

The three shipped-counter divergences (rows 7+9 on Swan, rows 11 and 14
on Helen3) share one root cause: `retype_item` in `src/lib/inventory.ts`
gated its shipped-accumulator block on **both** the old and the new key
existing in `idToItem`. When the old key was a renamed-away ghost
(Purple, Orange) the gate failed and the new key never received credit,
even though the order line was correctly moved old → new.

The order line move and the shipped adjustment have different
preconditions: the line move only needs the old line to be present on
the order; the shipped adjustment is per-side — decrement old only if
old still exists, increment new only if new exists. Coupling them was
the bug.

Fix (`src/lib/inventory.ts`, inside `r.addCase(retype_item, ...)`):

```diff
- if (state.idToItem[itemKey] !== undefined &&
-     state.idToItem[newItemKey] !== undefined) {
-   state.idToItem[itemKey].shipped -= moveQty;
-   state.idToItem[newItemKey].shipped += moveQty;
- } else { /* warn */ }
+ if (state.idToItem[itemKey] !== undefined) {
+   state.idToItem[itemKey].shipped -= moveQty;
+ }
+ if (state.idToItem[newItemKey] !== undefined) {
+   state.idToItem[newItemKey].shipped += moveQty;
+ } else { /* warn — new key missing */ }
```

Idempotency is preserved: `moveQty` derives from finding the old key on
the order's items (`oldItemIdx !== -1`), so a replayed-against-current
retype with no matching old line produces `moveQty = 0` and is a no-op
on both sides.

### Post-fix replay impact (Apr 25 backup, 24,799 actions)

Three `retype_item` actions now credit shipped where they previously
dropped it. Net delta vs. the unpatched reducer:

| At | Order | Old → New | qty | Credited to |
|---|---|---|---:|---|
| 2025-05-29 09:28:55 | `5XX72156AK696890X-2of3` | Purple → **Swan** | 1 | `4542804130904Swan` (+1) |
| 2025-07-25 12:59:04 | `Helen3` | Orange → **Strawberry** | 1 | `4542804112832Strawberry` (+1) |
| 2025-07-25 13:08:27 | `Helen3` | Orange → **Cherry** | 3 | `4542804112832Cherry` (+3) |

Final shipped readings after replay match the remediation table above:

```
4542804130904Swan:        shipped=1  qty=23
4542804112832Strawberry:  shipped=3  qty=11
4542804112832Cherry:      shipped=3  qty=10
```

Net +5 shipped units across 3 keys; no other inventory cell changes.
The 15 audit-page ghost-access events are unchanged — the audit fires
before the reducer outcome and measures structural lookup, not whether
the reducer eventually did the right thing.

### Regression coverage

`tests/unit/ghost-shipped-counter-replay.test.ts` replays the Apr 25
backup and asserts the three remediation targets land on the post-fix
values. Without the fix it fails on the very first assertion
(`Swan.shipped == 1`); with the fix it passes.

### What was NOT touched

`package_item` and `quantify_item` still skip their shipped block when
the literal `itemKey` is absent from `idToItem`. That's the right
behavior: those actions only carry the old key, with no semantic target
to redirect into. Rows 7, 10, 12, and 13 are the "ghost line drops onto
the order with no shipped change" steps; rows 9, 11, and 14 — the
follow-up retypes — are where the order line gets reconciled onto a
real key, and where the fix takes effect.

## Reproduction

```bash
bun run scripts/audit-missing-15.ts
# detailed JSON: /tmp/audit-missing-15.json
# human log:    /tmp/audit-missing-15.log

bun run scripts/assess-ghost-fix-impact.ts
# enumerates retype_item actions whose shipped behavior changes under
# the fix and prints the per-key net delta and final readings.

bun run test -- --run --no-coverage \
  tests/unit/ghost-shipped-counter-replay.test.ts
# vitest regression test (~50s; auto-skips if the backup is absent).
```

The audit script replays the apr-25 backup and emits the 15 records
with pre-state, final state, the relevant order-items snapshots, and
the `intentSatisfied` flag for field updates.
