# Code Review — `feat/order-exceptions` vs `main`

Scope: 28 commits, ~6000 lines. Event-sourced inventory cost engine, the
order-exceptions repair route, the stock-order cost/qty parsers, the
reconciling-TSV parser, and supporting replay/diff tooling.

Verdict: **solid and internally consistent.** The architecture (pure
derived cost ledger materialised on cold replay, schema-version gating,
ephemeral interceptor sub-actions) is coherent and well-tested. No
correctness blocker found. Items below are ranked; none block merge but
several are worth addressing before/after.

---

## High — worth addressing before merge

### H1. Float-exact reconciliation (`stock-order-cost-tsv.ts`)
`reconcileManual` / `reconcileStockOrderCostTsv` accept an interpretation
only when `interp.sum === valueOfGoodsJpy` (strict `===`). Since
`efa7de8`, `buildRows` for `kind:"total"` accumulates `sum += raw` where
`raw = parseAmount(cell)`. JPY invoices are integer-valued in practice so
this works today, but any decimal line amount (or a future supplier in a
sub-unit currency) makes the sum a binary float and `===` silently fails,
forcing the user down the discrepancy-approval path with a tiny non-zero
delta. Recommend an epsilon (e.g. `Math.abs(diff) < 0.5` for yen, or
round both sides) instead of `===`. Low effort, removes a latent UX trap.

### H2. `weightToleranceG` is preview-only; not threaded to commit
The route passes the user-chosen tolerance into `previewStockOrderFix`,
but the `fix_stock_order` interceptor (`root-reducer.ts:1460`) calls
`computeStockOrderCostCommit` **without** `weightToleranceG`, so commit
recomputes match rows at tolerance 0. This is *currently harmless* only
because the actual weight write is gated on `canFixWeight` (tolerance-
independent) and `weightMismatch` merely renders a warning. It is a
latent footgun: any future logic that gates a write on `weightMismatch`
will diverge between preview and commit. Either thread the tolerance
through the action payload + interceptor, or add a comment at the
interceptor stating the tolerance is intentionally a preview-only UX
filter and must never gate a write.

---

## Medium — follow-up

### M1. `toGrid` delimiter detection is whole-document
`stock-order-cost-tsv.ts:65` picks `\t` if the *entire paste* contains
any tab, else `,`. A comma-CSV with a stray tab inside one quoted cell
would be parsed as TSV and shatter. The previous code decided per-line,
which was also imperfect but failed more locally. Acceptable for the
known supplier sheets; consider Papa's delimiter auto-detection or
sampling the header row only. The accompanying fix itself (quote-aware
Papa parse replacing naive `split(/\r?\n/)`) is correct and well-tested
(`5c88205`) — this is only about the delimiter heuristic.

### M2. Mixed `seq` sources in the cost ledger (`inventory.ts`)
New receipts use `seq: ledger.length` (1213/1227) while the zeroed-order
splitter uses `seq: nextLedgerSeq(ledger)` (= max+1). After a splice the
two schemes can mint the same `seq`. `sortLedger` has a final
insertion-index tiebreak so determinism holds, but the `seq` field no
longer means "monotonic creation order," which is surprising given its
documented purpose ("deterministic tiebreak"). Recommend standardising
on `nextLedgerSeq` everywhere so `seq` stays a true total order.

### M3. `allocateZeroedStockOrderToReceipts` remainder lot
When an order's `orderedQty` is less than an existing scan lot, the lot
is split and the remainder gets `unitCostJpy/Eur: 0`,
`costOrderId: undefined`. This is the intended "only the ordered portion
gets the landed cost" behaviour, but it silently creates an *unpriced*
lot that will then surface as a `needsCost` exception for whatever
action originally sourced it. Confirm that is intended (it likely is —
it represents genuinely un-costed stock), and ideally add a unit test
asserting the remainder lot's provenance and that it does not get
re-attached by a later zeroed order (the `costOrderId` filter at 917
suggests this was considered — lock it with a test).

### M4. Review-doc artifact committed
`CLAUDE_ORDER_FIXUPS_REVIEW.md` (this file) and the investigation md/
jsonl fixtures are in the branch. Fixtures + design docs are
intentional and valuable; this review file should probably not be
committed to the feature branch (or should live under `docs/`).

---

## Low — nits / observations

- **L1.** `order-exceptions.ts` `canFixCountryOfOrigin = !existingCoo &&
  !!incomingCoo` only *fills* a blank COO; it never repairs a *wrong*
  COO (that path is a `warning` only). Consistent with the weight rule
  and probably deliberate (don't auto-overwrite human data), but worth a
  one-line comment so it isn't read as a bug later.
- **L2.** `parseStockOrderUnitCostJpy` rule 3 and `findWeight`/`findQty`
  rely on substring matching of normalised headers. This is the
  documented design and is now well-covered by tests, but it is
  inherently fragile to new supplier header wording — the
  manual-override dropdowns (`9b3c105`) are the right escape hatch and
  their existence mitigates this.
- **L3.** `fix_stock_order` interceptor emits `update_fields` per matched
  row inside a loop, each re-running the full `inventory` reducer and
  `logger`. Fine at current order sizes (tens–hundreds of rows); just
  note it is O(rows) full-reducer passes per commit if order sizes grow.
- **L4.** Several unrelated test files show a `+12/-12` churn
  (immutability, listing-*, shopify-*). Spot-checked: these are
  schema-version / fixture-bump mechanical updates, not logic changes —
  fine, but worth confirming none masked a real assertion change in
  review.
- **L5.** `schema-version.ts` is at 6 and its comment correctly explains
  why. Confirm one final bump is not also needed for the
  `efa7de8` total-cost-preservation change: it alters the *materialised*
  `unitCostJpy` for total-kind lots (now fractional, previously rounded).
  Any v6 snapshot captured *before* `efa7de8` would replay differently.
  If no such snapshot can exist yet (branch never deployed), no bump
  needed — but call it out explicitly.

---

## What's good (kept deliberately)

- The reconcile/preview/commit triad is genuinely *one* projection:
  `previewStockOrderFix` and the interceptor both go through
  `computeStockOrderCostCommit`, so the screen cannot lie about what
  commit will do. This is the right design and is the reason the
  earlier "0→0" and "two tables" bugs are gone.
- `lotMatchesOrder` as the single source/`costOrderId` predicate used by
  every consumer prevents the matching drift that plagued earlier
  iterations.
- Ephemeral interceptor sub-actions (`_ephemeral: true`) keep the
  broadcast log clean while still being replay-deterministic.
- Strong replay-based regression coverage: per-JAN replay fixtures
  (`4969757160602`, `4969757165348`, `4901681382316`, `4901681506606`)
  pin real production defects as executable tests.
- The TSV quoted-newline fix (`5c88205`) correctly aligns the
  exceptions parser with the order-import (Papa) parser; verified
  against the real Kanegen header.

## Test status

Full `bun run test` (entire Vitest unit suite with coverage) — **passed,
exit 0**. Targeted suites also verified individually during review
(cost-engine, order-exceptions, stock-order-cost, stock-order-cost-tsv)
and `svelte-check` reports 0 errors / 0 warnings. E2E (`npm run
test:e2e`) was not run as part of this review and is still required by
the pre-push hook before any PR.
