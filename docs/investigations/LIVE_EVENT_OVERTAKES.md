# Live-event over-takes: taking more to a show than remained after the last one

Generated 2026-06-15 from `../production-backup-jun-11`.
Reproducer: `bun scripts/find-live-event-overtakes.ts ../production-backup-jun-11`

## Problem

The Thessaloniki Comic Con oversells trace to a process slip: the count
**taken to Thessaloniki was never reduced by what the previous show (Japan
Festival) had already sold**. The operator carried forward the prior count, so
for items with thin stock the second show "sold" goods that no longer existed.

The sheets make this hard to see by eye because the `Inventory Count per
system` and `Actual inventory count in office` columns are **stale** — the same
original count appears on both shows' sheets (e.g. Bag Shopping Botanical Cream
shows 12 on both, although Japan Festival had sold 6), and `Returned from …` is
left blank. So the remaining stock must be **computed**, not read off the later
sheet.

## Detection

For each `commit_import` the script recovers the committed paste, parses it with
the production parser, and for the chosen previous/later shows flags every item
where the later show's taking exceeds what should have remained:

```
remaining_after_previous = previous.(actualOfficeCount ?? systemCount) - previous.sold
flag when  taking(later) > remaining_after_previous
```

Committed pastes used: Thessaloniki Comic Con (commit `3FxZC2TXnuSvFfe11nt3`,
paste `kEFFQp7ItVWmbCjiWnRC`) and the Japan Festival before it (commit
`Jq3zaog7ylDSNM87ngbw`, paste `TWbElJuYfYj1uAcMjgxx`).

## Finding

**6 lines** were over-taken to Thessaloniki. **2 of them became real inventory
oversells** (cross-referenced against `OVERSOLD_ITEMS.md`); the other 4 were
over-taken but did not sell enough at Thessaloniki to drive inventory negative,
so they are process risks rather than realized losses.

`count` and `sold` are from the Japan Festival sheet; `remain = count − sold` is
the stock that should have been left; `took` is taking to Thessaloniki, `+over`
how much that exceeds `remain`; `Thess sold` is what actually sold there.

| Item | Description | JF count | JF sold | remain | took | over | Thess sold | Oversold? |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `4589469849758 / Default` | Gacha Blind Mystery Box — Neko Cat | 10 | 9 | 1 | 9 | **+8** | 8 | oversold 7 |
| `4542804080773 / Cream` | Bag Shopping Botanical | 12 | 6 | 6 | 12 | **+6** | 12 | oversold 6 |
| `4542804155181 / Green` | Amifa A5 Two-Zipper Net Stationery Case | 12 | 2 | 10 | 15 | **+5** | 3 | — |
| `4542804080773 / Green` | Bag Shopping Botanical | 10 | 4 | 6 | 10 | **+4** | 5 | — |
| `4542804117844 / Beige` | Amifa Toile de Jouy Drawstring Lunch Bag | 10 | 5 | 5 | 6 | **+1** | 1 | — |
| `4991203205377 / Brown` | Senshu Kawaii Neko Cat Coaster | 10 | 6 | 4 | 5 | **+1** | 2 | — |

## Notes

- **Over-taken ≠ oversold.** Taking more than remained is the process error;
  an oversell only results if enough then sells. Gacha (took 9 with 1 left,
  sold 8 → oversold 7) and the Cream bag (took 12 with 6 left, sold 12 →
  oversold 6) realized it; the other 4 sold within their actual stock buffer.
- **This refines the earlier "same count to both shows" idea.** That heuristic
  flagged 70 lines (any item taken in equal quantity to both shows while Japan
  Festival had sold > 0) but caught only the Cream bag among the oversells. The
  over-take test here is the precise criterion: it catches Gacha (taking was
  reduced 10 → 9, so "same count" missed it, yet 9 ≫ the 1 that remained) and
  drops the 64 coincidental same-count lines that were never over-taken.
- **Not every Thessaloniki oversell is here.** The three Pilot ILMILY pens
  (`4902505660405 / 412 / 450`, oversold 1 each) are not in the Japan
  Festival/Thessaloniki sheets under their JAN keys, so the sheet comparison
  cannot see them; their −1s trace to the Thessaloniki commit but enter via a
  different line and need a per-row look on the sheet.

## Recommendation

Seed each show's `Taking to …` column from the **current** on-hand (after the
previous show's sales), not from the previous show's taking, and fill in
`Returned from …` so the sheets stay self-consistent. The realized oversells
are enumerated and validated in `OVERSOLD_ITEMS.md`.
