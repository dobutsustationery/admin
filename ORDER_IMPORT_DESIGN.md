# Order Import Design Document

## Overview

The **Order Import** feature streamlines the process of adding new inventory by analyzing spreadsheet invoices or packing lists (from vendors) stored in Google Drive. This system scans the spreadsheet for JAN codes, cross-references them with the existing inventory, and facilitates updates for both known and new items.

## Goal

To enable users to import inventory quantities directly from supplier invoices/packing lists, reducing manual data entry and ensuring accuracy.

## User Flow

1.  **Selection**: User navigates to "Order Import" and selects a spreadsheet file (invoice/packing list) from a configured Google Drive folder.
2.  **Analysis**: The system downloads and analyzes the spreadsheet to identify JAN codes and associated quantities.
3.  **Review**: The user is presented with a summary of the analysis:
    *   **Known Items**: Products already in inventory.
    *   **New Items**: JAN codes not found in inventory.
    *   **Subtype Conflicts**: Items where the JAN code is associated with a product family (subtypes) rather than a single SKU.
4.  **Confirmation/Action**:
    *   For **Known Items**, the user confirms the quantity update.
    *   For **New Items**, the system creates a "pending" entry for later completion (e.g., photo scanning flow).
    *   For **Subtype Conflicts**, the system automatically divides the total quantity evenly among all subtypes. The user can review and adjust this allocation if necessary.
5.  **Execution**: Upon confirmation, the system updates the inventory records.

## Data Analysis & Actions

The core of the import process is the transformation of static spreadsheet data into actionable inventory events. We will represent these potential updates as Redux actions.

### 1. Spreadsheet Analysis
The analysis phase produces an "Import Plan" consisting of the following categories:

*   **`MATCH_FOUND`**: JAN code exists and maps to a unique SKU.
    *   *Action*: `UPDATE_INVENTORY(id, quantity)`
*   **`NEW_ITEM`**: JAN code does not exist in the database.
    *   *Action*: `CREATE_DRAFT_ITEM(janCode, quantity)`
*   **`SUBTYPE_CONFLICT`**: JAN code maps to a parent product with multiple subtypes.
    *   *Action*: `PROMPT_ALLOCATION(parentId, totalQuantity)` (Defaults to even split)

### 2. Redux Actions
To standardize the process and allow for "undo" or "retry" capabilities, the import implementation should leverage standard Redux patterns.

*   `ANALYZE_SHEET_RANGE(fileId, range)`: Triggers the backend/API to fetch and parse the sheet.
*   `IMPORT_PLAN_GENERATED(plan)`: Stores the analysis result in the local state.
*   `RESOLVE_CONFLICT(janCode, allocation)`: User input to resolve a subtype conflict.
*   `COMMIT_IMPORT(plan)`: Finalizes the changes and writes to Firestore.

## User Interface Design

### 1. File Picker
*   **Component**: `GoogleDrivePicker` (reusing existing Drive integration).
*   **Filter**: Restrict to Spreadsheet MIME types (`application/vnd.google-apps.spreadsheet`).

### 2. Analysis Summary
*   **Visual**: A dashboard showing counts of:
    *   ✅ Ready to Update (Known SKUs)
    *   ⚠️ Needs Attention (Subtypes)
    *   🆕 New Items (Unknown JANs)
*   **Interaction**: Click on "Needs Attention" to expand a modal for resolving subtype allocations.

### 3. Conflict Resolver
*   **UI**: A list of resolving items.
*   **Input**: For a JAN code like `4902778123456` (Pen Family), show all known subtypes (Red, Blue, Black). The interface defaults to an even split of the total quantity (e.g., if total is 30, each gets 10).
*   **Constraint**: Ensure the sum of user-entered quantities matches the total from the invoice.

## Integration Points

### Google Drive API
*   Use the `spreadsheets.values.get` endpoint to read data.
*   Requires `https://www.googleapis.com/auth/spreadsheets.readonly` scope.
*   *Note*: The existing integration currently handles Drive Files; it will need to be extended to handle Sheets API or export Sheets as CSV. Exporting as CSV (`/export?mimeType=text/csv`) is often simpler than using the full Sheets API if we only need read-only access.

### Inventory Store
*   Must support looking up items by JAN code efficiently.
*   Must handle the creation of "Draft" or "Incomplete" items that act as placeholders until the physical product verification (Photo Scan) occurs.

## Future Considerations
*   **LLM Parsing**: If the spreadsheet structure is irregular (not a standard CSV), we can use an LLM to identify which columns correspond to JAN Code and Quantity.
*   **Photo Workflow Bridge**: "New Items" from the spreadsheet import should automatically populate the "Expected" queue in the Photo Scanning workflow.
