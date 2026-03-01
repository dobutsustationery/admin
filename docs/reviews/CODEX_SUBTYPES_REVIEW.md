# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues

No remaining critical blockers identified after the latest fixes.

## Major Gaps / Poor Design Decisions

No remaining major gaps after the latest fixes.

## Missing Features

No remaining missing features identified after the latest fixes.

## Recommendations

No additional recommendations at this time.

## Summary

The subtype design doc is implemented end‑to‑end: `generate_proposals` builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, approval can split inventory, delete/replace respects `sourceGroup`, allocation is strictly enforced to match source stock, collision handling covers both existing inventory IDs and intra‑batch duplicates, and the batch editor now surfaces subtype context (photo group and stock) alongside allocations.

## Review Update (2026-02-01)

Batch editor visibility was added in `85cb81b`, resolving the final open item from the review.
