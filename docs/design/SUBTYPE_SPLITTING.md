# Subtype Splitting Design

## 1. The Problem
We frequently encounter products that share a single JAN code (e.g., `4542804104370`) but have distinct visual variations (e.g., "Blue" vs "Red" designs). 
-   **Inventory**: Initially arrives as a single pooled quantity under the base JAN.
-   **Photos**: Are often categorized more granularly (e.g., `JAN:Blue`, `JAN:Red`) by our photo analysis pipeline.
-   **Goal**: We want to end up with distinct SKUs (Subtypes) in our inventory and distinct Variants in our Shopify listing, without manual data entry for each one.

## 2. When do we decide on subtypes?
We decide on subtypes during the **Listing Creation (Proposal)** phase.

This is the optimal point because:
1.  **Visual Confirmation**: The user is looking at the photos and can confirm that "Blue" and "Red" are indeed different variants.
2.  **Allocation**: The user needs to decide how to split the pooled inventory quantity (e.g., if we have 10 total, is it 5 Blue/5 Red, or 8/2?). This requires human input.
3.  **Context**: The Listing Proposal aggregates data from both Inventory and Photos, making it the natural place to merge these concepts.

## 3. Technical Implementation

### 3.1 Prerequisite: Persisting Photo Splits (The Missing Link)
Currently, `src/lib/gemini-client.ts` *detects* subtypes during "Generate Descriptions" and updates the local UI, but it **does not** update the Redux state (`janCodeToPhotos`). This means `generate_proposals` never sees the `JAN:Subtype` keys.

**Required Fix:**
1.  **Update `processMediaItems`**: Return `photoId`s in the results, not just URLs.
2.  **Update `handleGenerate` (Photos Page)**: Upon completion of generation (or detection of a split), dispatch Redux actions (`categorize_photo` or `split_jan_group`) to formally move the photos into new `JAN:Subtype` keys in the global state.
3.  **Result**: `store.photos.janCodeToPhotos` will contain keys like `454...:Blue` and `454...:Red`.

### 3.2 Trigger: Proposal Generation
When `generate_proposals` runs (triggered from the Photos page):
1.  **Group Photos**: It identifies that multiple photo groups exist for a single Base JAN (e.g., `454...:Blue` and `454...:Red`).
2.  **Multi-Variant Proposal**: Instead of creating separate proposals or ignoring the suffixes, it creates a **Single Proposal** for the Base JAN.
3.  **Variant Pre-population**: It pre-fills the `variants` array of the proposal:
    -   **Variant A**: `option1Value: "Blue"`, linked to photo group `454...:Blue`.
    -   **Variant B**: `option1Value: "Red"`, linked to photo group `454...:Red`.

### 3.3 User Action: Listing Detail
The user opens the proposal in the Listing Detail view.
1.  **Visuals**: They see two variants pre-created.
2.  **Stock Allocation**: The UI prompts them to allocate the total stock (e.g., 10 units) across these variants.
3.  **Refinement**: They can rename "Blue" to "Navy" or add price differentials if needed.

### 3.4 Persistence: Approval
When the user clicks **Approve & Publish**:
1.  **Inventory Split**: The system takes the Base Inventory Item (`454...`) and performing a **Split Operation**.
    -   It reduces the Base Item quantity.
    -   It creates new Inventory Items for the subtypes (e.g., `454...Blue`, `454...Red`) with the allocated quantities.
2.  **Listing Creation**: It creates a Shopify Listing with variants corresponding to these new Inventory Items.
3.  **Photo Association**: The specific photos for "Blue" are assigned to the "Blue" variant image in Shopify.

## 4. Alternative: Order Import
If the Supplier Invoice (CSV) explicitly lists variants (e.g., different rows for same JAN but different descriptions/prices), the **Order Import** process can also initiate splitting.
-   **Logic**: If multiple CSV rows map to the same JAN, the Order Import UI flags a **Conflict**.
-   **Resolution**: The user resolves this by creating **Subtypes** (New Items) directly during import.
-   **Result**: The Inventory is already split *before* Listing Creation.
-   **Listing Creation**: When generating proposals later, it sees distinct Inventory Items (`JAN:Blue`, `JAN:Red`) and treats them as separate (or merges them into one listing if they share a handle).

## 5. Summary
-   **Photos-driven Splitting**: Happens during **Listing Creation**. User allocates stock based on visual evidence. Requires fixing the Photo Processing pipeline to persist detected splits.
-   **Data-driven Splitting**: Happens during **Order Import**. User confirms new subtypes based on invoice rows.