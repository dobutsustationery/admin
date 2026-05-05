# Live Event Sales Import Design

> **Status: Implemented** - Manual pasted TSV/CSV import for sales counted at live events.

## Problem

Live event sales are currently reconciled outside the main import workflows. The source data is usually a copied spreadsheet with inventory taken to the event, inventory returned from the event, and a sold count per JAN/subtype row.

We need a flow that:

- accepts pasted TSV or CSV directly in the browser;
- previews the rows before inventory is changed;
- lets the user approve or unapprove rows interactively;
- commits approved sales into the same inventory/order model used by other sales flows;
- keeps the pasted text as the durable source fact so replay can benefit from parser and reducer fixes.

## Source Fact

The persisted fact is the raw pasted text:

```ts
liveEventImport / set_paste({ rawPaste });
```

The reducer parses the paste into review rows. It stores the original paste, detected delimiter, inferred event name, row errors, warnings, and default row approval state. The UI does not persist an import plan.

Supported columns include:

- `janCode`
- `subtype`
- `description`
- `image`
- `hsCode`
- `qty`
- `pieces`
- `shipped`
- `Inventory Count per system`
- `Actual inventory count in office`
- `Taking to <event name>`
- `Returned from <event name>`
- `Sold`

`Sold` is authoritative when present. If `Sold` is missing, the reducer derives sold quantity from `Taking to ... - Returned from ...`. If both are present and disagree, the reducer keeps `Sold` and records a warning.

## Reducer Responsibility

`live-event-import-slice.ts` owns paste parsing and row approval state. It does not write inventory directly.

The root reducer intercepts:

```ts
liveEventImport / commit_import();
```

From the current pasted rows plus current inventory, it computes approved sale lines, synthesizes a `new_order` for the event, synthesizes `package_item` actions for each sold inventory item, and marks committed rows done.

This keeps the irreversible inventory effect derived from replayable state:

1. raw paste fact;
2. approval intents;
3. commit intent;
4. reducer-computed order/package actions.

## Matching Rules

Rows match inventory in this order:

1. exact local inventory key: `makeInventoryItemKey(janCode, subtype)`;
2. unique JAN fallback when exactly one inventory item has the pasted JAN.

Rows with no match remain visible and are not committed. A row with `Sold = 0` can be committed and marked done, but it does not synthesize a package action.

## UI

The `/live-event-import` route provides:

- a paste area for TSV/CSV;
- summary counts for approved rows, committed rows, and rows needing attention;
- a review table with image, item identifiers, count columns, sold quantity, current available count, and projected available count;
- approval checkboxes per row plus approve all / unapprove all controls;
- a commit button for approved valid rows.

Oversold rows are warned but not blocked because the live count may be the physical source of truth. Missing inventory matches are blocked until unapproved or fixed by changing inventory/source data.

## Non-goals

- Editing pasted cell values in derived state.
- Creating new inventory items from live event sales rows.
- Replacing Shopify/Etsy order sync or the older archive-based show sales view.

## Rollout Notes

The feature is additive:

- new `liveEventImport` Redux slice;
- new `/live-event-import` route;
- root reducer interception for commit;
- navigation entry;
- unit coverage for parsing and commit computation.
