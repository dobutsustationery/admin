# Branch Analysis (design/listings-creation vs main)

Date: 2026-02-09
Scope: `git diff main HEAD`

## Executive Summary
This branch introduces a large listings-creation feature set plus significant supporting infrastructure. The most notable behavioral changes are in listing approval/merging, bulk editor sorting, audit export/replay, and category validation in the listing editor. Overall the changes are coherent, but there are a few high-risk gaps and some incomplete integration points that can cause broken flows (especially category selection and replay/export correctness when timestamps are missing).

## High‑Risk / Likely Bugs
1. Category validation can block approval when the taxonomy list is empty.
   - `ListingEditor` now requires `productCategory` to be a member of `knownCategories`. If `knownCategories` is empty (likely on new installs or before any Shopify import), the dropdown will show “No matching categories” and category updates are rejected.
   - Impact: Listing creation can be blocked with no way to set a valid category, even if the user knows the correct category string.
   - Fix: Wire `knownCategories` to a canonical Shopify taxonomy list (static JSON or fetched), or provide a fallback list; alternatively, allow manual entry when the list is empty.

2. Replay order validation ignores actions without timestamps.
   - `scripts/replay-actions.ts` now throws if timestamps are out of order, but actions without a timestamp are not checked. A file with missing timestamps can still be out of order without triggering an error.
   - Impact: Replay may still silently apply out-of-order actions, producing confusing diffs.
   - Fix: Either require timestamps on all actions in exported audit logs, or add a “strict” mode to error if any action is missing a timestamp.

## Medium‑Risk / Potential Issues
1. Listings handle correction on approval is not logged as an action.
   - The approval interceptor now directly normalizes `listings.idToHandle` for merged items and cleans old handles without emitting a logger action. This is deterministic on replay, but it’s not visible in logged actions, which may make debugging harder.
   - Impact: Audit/debugging can be confusing because the fix is invisible in action logs.
   - Fix: Optionally emit an ephemeral action (or a debug log) that describes the normalization.

2. Audit export ordering depends on timestamp fields.
   - Export now sorts by `seconds + nanoseconds`, which is correct, but items without timestamps get `0` and sort first.
   - Impact: If the audit view includes actions with missing timestamps, exported order can be incorrect.
   - Fix: Either exclude timestamp-less actions or preserve file order for those items.

## Low‑Risk / Style / Maintenance
1. Listing editor category validation is strict string match.
   - Only exact matches in `knownCategories` are accepted. This is probably intended, but it increases UX friction if the list uses slightly different spacing/casing.
   - Mitigation: Normalize categories (case/spacing) or show a “closest match” suggestion.

2. Replay tool diff behavior is now more conservative.
   - The `diff` helper returns `null` for no changes and marks deletions as `null` values. This is acceptable but should be documented in the tool output for clarity.

## Unimplemented or Incomplete Features
1. Canonical Shopify category list not integrated.
   - The UI expects `knownCategories` but there’s no static taxonomy or fetch path wired in the codebase. This leaves category selection dependent on prior listings/imports.
   - Recommendation: Add a canonical taxonomy dataset and load it into `listings.knownCategories` on startup.

2. Replay export correctness depends on audit search mode context.
   - Export operates on the current `actions` list, which in search mode is derived from cached actions and includes computed “children.” That’s fine, but the export filter excludes `_ephemeral` actions only; it does not enforce that the visible list is complete.
   - Recommendation: Expose a “full export” option that pulls from cached actions explicitly rather than the filtered view.

## Notable Improvements
- Bulk editor sorting now persists and supports multi‑column ordering with visible indicators.
- Listing approval now correctly normalizes handles for merged JANs to avoid stale handle mappings.
- Audit export ordering is deterministic with nanosecond precision.
- Replay tool now fails fast on out‑of‑order timestamps.

## Suggested Follow‑Ups
1. Add a Shopify taxonomy source and populate `knownCategories` at startup.
2. Add a strict replay option that requires timestamps on all actions.
3. Consider logging handle normalization as an ephemeral debug action for replay clarity.

