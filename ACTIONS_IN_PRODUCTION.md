# Actions in Production

Analysis of `test-data/firestore-export.json` (24MB, ~3500 actions).

## Summary

-   **Total Unique Actions**: 11 types.
-   **Missing Actions**: `append_raw_rows` is NOT present. This indicates that raw CSV data was not stored for past imports.
-   **Dominant Action**: `update_item` (1225 count) accounts for the bulk of the initial state. Since raw rows are missing, we must treat these `update_item` events as the "foundational facts" for existing inventory, even though they contain derived data (HS Codes, etc.) that we would ideally calculate from raw inputs.

## Action Enumeration and Classification

### `update_item`
-   **Count**: 1225
-   **Classification**: **YELLOW / RED** (Legacy)
-   **Payload**: `{"item": {"janCode": "...", "description": "...", "hsCode": "...", ...}, "id": "..."}`
-   **Analysis**: Contains fully parsed/derived data. Ideally, this would be Green (Raw) + Green (Trigger), but since we lack the raw source for these records, we must accept them as the defacto source of truth for historical data. Going forward, we should avoid generating these from imports.

### `package_item`
-   **Count**: 1167
-   **Classification**: **GREEN**
-   **Payload**: `{"orderID": "...", "itemKey": "...", "qty": 1}`
-   **Analysis**: Represents a physical operational event (packing an item). Safe.

### `update_field`
-   **Count**: 456
-   **Classification**: **GREEN**
-   **Payload**: `{"field": "description", "from": "...", "to": "...", "id": "..."}`
-   **Analysis**: Represents a specific manual correction or edit by a user. Safe user intent.

### `quantify_item`
-   **Count**: 359
-   **Classification**: **GREEN**
-   **Payload**: `{"orderID": "...", "itemKey": "...", "qty": 0}`
-   **Analysis**: Operational event (setting quantity for an order). Safe.

### `retype_item`
-   **Count**: 250
-   **Classification**: **GREEN**
-   **Payload**: `{"orderID": "...", "itemKey": "...", "subtype": "...", "janCode": "..."}`
-   **Analysis**: User intent to correct/refine an item's classification. Safe.

### `create_name`
-   **Count**: 210
-   **Classification**: **GREEN**
-   **Payload**: `{"name": "...", "id": "HS Code"}`
-   **Analysis**: Configuration/Metadata input (e.g. adding valid HS codes). Safe.

### `rename_subtype`
-   **Count**: 28
-   **Classification**: **GREEN**
-   **Payload**: `{"itemKey": "...", "subtype": "..."}`
-   **Analysis**: User intent (refactor). Safe.

### `archive_inventory`
-   **Count**: 2
-   **Classification**: **GREEN**
-   **Payload**: `{"archiveName": "..."}`
-   **Analysis**: Lifecycle event. Safe.

### `delete_empty_order`
-   **Count**: 1
-   **Classification**: **GREEN**
-   **Payload**: `{"orderID": "..."}`
-   **Analysis**: Cleanup operation. Safe.

### `hide_archive`
-   **Count**: 1
-   **Classification**: **GREEN**
-   **Payload**: `{"archiveName": "..."}`
-   **Analysis**: UI state/preference. Safe.

### `make_sales`
-   **Count**: 1
-   **Classification**: **GREEN**
-   **Payload**: `{"archiveName": "...", "date": ...}`
-   **Analysis**: Lifecycle event. Safe.

## Conclusion

The system history is largely built on `update_item` (Legacy Audit) followed by a stream of Green operational events.
**Refactor Implication**:
1.  We cannot "fix" past import parsing errors by replaying, because the raw CSVs are missing ("Red" data).
2.  We **can** and **should** switch to the "Green" path (`append_raw_rows` + `finalize_import`) for **all future imports**.
3.  We must ensure the reducer handles both legacy `update_item` (for history) and new `finalize_import` (for future) correctly.
