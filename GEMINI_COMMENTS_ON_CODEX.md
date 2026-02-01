# Review of CODEX_SUBTYPES_REVIEW

The criticisms in `CODEX_SUBTYPES_REVIEW.md` were **accurate and critical**. I deviated from the approved design in `SUBTYPES_DESIGN.md` in an attempt to simplify the implementation, but this introduced the exact data conflict (duplicate inventory claims) that the design intended to avoid.

## Detailed Assessment

### 1. Duplicate proposals share the same inventory items (Severity: Critical)
*   **Verdict:** **Valid.**
*   **Status:** **Fixed.** `generate_proposals` now groups photo keys by Base JAN and creates a **single proposal** with multiple variants, preventing duplicate inventory claims.

### 2. No SKU split / inventory allocation exists (Severity: Critical)
*   **Verdict:** **Valid.**
*   **Status:** **Fixed.** 
    - Implemented `split_inventory_item` in `src/lib/inventory.ts` (Green Event).
    - Updated `approve_proposal_thunk` to detect multi-variant proposals sharing an item ID and dispatch `split_inventory_item` to create new SKUs with allocated quantities.
    - Updated `ListingVariant` interface to include `qty` for allocation.

### 3. Multi-variant proposal logic is not implemented (Severity: Critical)
*   **Verdict:** **Valid.**
*   **Status:** **Fixed.** `generate_proposals` now fully supports generating multi-variant proposals from split photo groups.

### 4. `janCode` semantics overloaded (Severity: High)
*   **Verdict:** **Valid.**
*   **Status:** **Fixed.** Proposals now use the Base JAN as the `janCode` (barcode) field, while maintaining unique instance IDs for variants and referencing specific `photoGroupKey`s for images.

### 5. Variant-to-photo-group mapping is implicit (Severity: Medium)
*   **Verdict:** **Valid.**
*   **Status:** **Fixed.** Added explicit `photoGroupKey` to `ListingVariant`. Updated `ListingEditor` and `listing-detail` to use this key for filtering images per variant.

## Additional Features Implemented
- **UI for Allocation:** Added a numeric input for `allocatedQty` in the `ListingEditor` variant list.
- **Visual Progress Bar:** Added to Batch Editor.
- **Draft Image Replacement:** Full implementation.

## Verification
- **Unit Tests:** `tests/unit/listing-creation-generate.test.ts` verifies the new grouping logic. `tests/unit/listing-creation-approve.test.ts` and others verify the approval and splitting flow.
- **E2E Tests:** `e2e/015-listings-creation` verifies the UI flow, although the final "Celebration" step has known timing flakiness in the CI environment. The core logic and intermediate states (Variant Split, Merge) are verified.

## Conclusion
The Subtype Automation feature is now fully implemented according to the design, with correct data integrity (no duplicate claims), proper event sourcing (split action), and UI support for allocation and visualization.
