# Action Audit

This document categorizes existing actions based on the "Facts vs. Intent" philosophy.
**Green**: Safe. Represents raw input or explicit user decisions.
**Red**: Unsafe. Represents derived data that freezes logic in the log.
**Yellow**: Context-dependent.

## Slice: `orderImport` / `shopifyImport`

| Action | Status | Analysis |
| :--- | :--- | :--- |
| `append_raw_rows` | **GREEN** | Raw CSV data. The source of truth. |
| `set_header` | **GREEN** | User intent / configuration. |
| `resolve_conflict` | **GREEN** | Explicit user decision (User Intent). |
| `mark_items_done` | **GREEN** | UI state / User Intent. |
| `start_session`, `clear_import` | **GREEN** | Session management. |

## Slice: `inventory`

| Action | Status | Analysis |
| :--- | :--- | :--- |
| `bulk_import_items` | **RED** | **CRITICAL ISSUE**. Payload contains fully parsed `Item` objects. If parsing rules change (e.g., HS Code detection), this action remains "wrong" in the log. **Rec:** Replace with `finalize_import` that triggers parsing of raw rows. |
| `update_item` | **YELLOW** | If used for single-item manual edits: **GREEN** (Intent). If used by a script/import to set properties derived from raw data: **RED**. |
| `update_field` | **GREEN** | Represents a specific manual edit to a field. |
| `new_order` | **GREEN** | Explicit operation. |
| `package_item` | **GREEN** | operational fact. |
| `quantify_item` | **GREEN** | Operational fact. |
| `retype_item` | **GREEN** | Refactoring intent. |
| `rename_subtype` | **GREEN** | Refactoring intent. |
| `archive_inventory` | **GREEN** | User intent. |
| `inventory_synced` | **GREEN** | System lifecycle event. |

## Slice: `listings`

| Action | Status | Analysis |
| :--- | :--- | :--- |
| `create_listing` | **YELLOW** | If created manually: Green. If created by import process: Red (should be derived). |
| `update_listing` | **GREEN** | Manual edit (User Intent). |
| `add_listing_image` | **GREEN** | Manual edit. |

## Slice: `photos`

| Action | Status | Analysis |
| :--- | :--- | :--- |
| `select_photos` | **GREEN** | User selection (Intent). |
| `categorize_photo` | **GREEN** | User organization (Intent). |
| `complete_upload` | **GREEN** | Fact (Upload finished, URL exists). |

## Summary of Fixes Required

1.  **Refactor Import Flow**: Abolish `bulk_import_items`. Implement `finalize_import` that reads `orderImport` state (raw rows) and applies current code logic to update `inventory`.
2.  **Verify `update_item` Usage**: Ensure it's only used for manual overrides, not bulk processing.
3.  **Listings Import**: Ensure listings generated from imports follow the same "raw + trigger" pattern, rather than committing parsed listings.
