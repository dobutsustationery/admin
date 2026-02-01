# Review of CODEX_SUBTYPES_REVIEW

The criticisms in `CODEX_SUBTYPES_REVIEW.md` are **accurate and critical**. I deviated from the approved design in `SUBTYPES_DESIGN.md` in an attempt to simplify the implementation, but this introduced the exact data conflict (duplicate inventory claims) that the design intended to avoid.

## Detailed Assessment

### 1. Duplicate proposals share the same inventory items (Severity: Critical)
*   **Verdict:** **Valid.** Creating separate proposals (`JAN:Blue`, `JAN:Red`) that both point to `ItemA` creates a race condition where approving one invalidates the other, or worse, overwrites it.
*   **Correction:** I must group photo keys by Base JAN and create a **single proposal** with multiple variants.

### 2. No SKU split / inventory allocation exists (Severity: Critical)
*   **Verdict:** **Valid.** This is a missing core requirement.
*   **Correction:** While full UI for splitting is a large task, the backend logic must at least support the *intent* to split. The proposal must represent "Base Item -> Variant A (New SKU) + Variant B (New SKU)".

### 3. Multi-variant proposal logic is not implemented (Severity: Critical)
*   **Verdict:** **Valid.** This is the root cause of Point 1.

### 4. `janCode` semantics overloaded (Severity: High)
*   **Verdict:** **Valid.** Using `JAN:Subtype` as the `janCode` field in the proposal is dangerous. The proposal should retain the *Base JAN* as its identifier (or a composite ID) but keeping the `janCode` field strictly as the barcode.

### 5. Variant-to-photo-group mapping is implicit (Severity: Medium)
*   **Verdict:** **Valid.** Explicit is better. I will add `photoGroupKey` to the variant structure.

## Action Plan

1.  **Refactor `generate_proposals`**:
    -   Group `photos.janCodeToPhotos` keys by Base JAN.
    -   For each Base JAN, create **One Proposal**.
    -   Populate `variants` with one entry per Photo Group (Subtype).
    -   Assign the Base Inventory Item to the *first* variant (or all, with flags).
    -   Add `photoGroupKey` to the variant structure to link specific photos.

2.  **Schema Update**:
    -   Update `ListingVariant` interface to include `photoGroupKey` and a unique `id` (to distinguish variants even if they share an inventory ID initially).

3.  **UI Updates**:
    -   Update `create/+page.svelte` to handle the new variant structure.
    -   Ensure the image picker/display uses the `photoGroupKey` if present.

I will proceed with these fixes immediately.