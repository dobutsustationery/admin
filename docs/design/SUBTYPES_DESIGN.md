# Subtype & Variant Automation Design

## 1. Problem
When importing products, we often have a single JAN code (e.g., `4542804104370`) that covers multiple visual variants (e.g., "Blue" vs "Red" stickers).
-   **Photos**: We have distinct groups of photos for each variant (detected by Gemini as `JAN:Blue` and `JAN:Red`).
-   **Inventory**: We currently have a single pool of stock under the base JAN `4542804104370`.
-   **Gap**: The current `generate_proposals` logic looks for exact JAN matches. It fails to match `JAN:Blue` to `JAN`, resulting in these items being skipped. Furthermore, we need to automatically split the inventory item (or create new SKUs) to match these new subtypes.

## 2. Desired Workflow
1.  **Photo Analysis**: (Already Implemented) Gemini splits photos into `JAN:Subtype` groups.
2.  **Proposal Generation**:
    -   When scanning `photos.janCodeToPhotos`, if we encounter a split key (`BaseJAN:Subtype`):
    -   Look up the **Base Inventory Item** using `BaseJAN`.
    -   **Action**: Create a Proposal for this specific subtype.
    -   **SKU Logic**: The proposal should effectively suggest: "Take *some* of the stock from Base Item and move it to a new Item `BaseJAN+Subtype`".
    -   **Or Simpler**: The Proposal is for the *Base Item*, but it defines a specific *Variant* configuration.
3.  **Conflict Resolution**:
    -   If we have `JAN:Blue` and `JAN:Red` photo groups, and only one Inventory Item `JAN`, we cannot have two separate *Draft Proposals* claiming the same Inventory ID.
    -   **Solution**: We should generate **One Proposal** for the Base JAN, but pre-populate it with **Two Variants** (`Blue` and `Red`), associating the respective photo groups to each variant.

## 3. Technical Implementation

### 3.1 `generate_proposals` Logic Update
The `generate_proposals` thunk in `src/lib/listing-creation-slice.ts` needs to be smarter.

**Algorithm:**
1.  **Group Photo Keys by Base JAN**:
    -   Iterate `photos.janCodeToPhotos`.
    -   Map `BaseJAN` -> `[ { key: 'JAN:Blue', subtype: 'Blue' }, { key: 'JAN:Red', subtype: 'Red' } ]`.
    -   Standard keys (`JAN`) map to `[ { key: 'JAN', subtype: null } ]`.

2.  **Iterate Base JANs**:
    -   For each `BaseJAN`, find matching `InventoryItems`.
    -   If no items, skip.

3.  **Construct Proposal**:
    -   **Case A: Single Photo Group (No Split)**
        -   Create standard proposal (as today).
    
    -   **Case B: Multiple Photo Groups (Split)**
        -   Create a **Multi-Variant Proposal**.
        -   **Variants**:
            -   For each photo group (e.g., "Blue"), create a variant entry.
            -   **Inventory Allocation**: Since we don't know how many of the 10 items are "Blue" vs "Red", we can't fully split the inventory yet.
            -   **Strategy**: Assign the **Base Item** to the *First* variant. Create **Virtual/Placeholder Variants** for the others?
            -   *Alternative*: We simply create the proposal with multiple defined variants, but they all currently point to the *same* inventory item ID? No, that breaks the "One Item = One SKU" rule.
            -   *Better Alternative*: We prompt the user.
            -   **Chosen Approach**: We create **New Item IDs** (Variant SKUs) in the proposal structure.
                -   Variant 1 (Blue): Points to existing Item ID (retyped as Blue).
                -   Variant 2 (Red): Points to a **New Pending Item** (suffix `Red`).
                -   The UI must ask "How many are Red?".
    
    -   **Revised Case B (Simpler)**:
        -   Just creating the proposal with the correct `variants` array structure is enough for the UI to render the "Split" view.
        -   We map the specific photo groups to the specific variants.
        -   `photoGroupIds`: `['JAN:Blue', 'JAN:Red']`.
        -   `variants`: 
            -   `{ option1Value: 'Blue', images: ['JAN:Blue'] }`
            -   `{ option1Value: 'Red', images: ['JAN:Red'] }`

### 3.2 Data Structure Changes
We need to ensure `ListingProposal` can carry the mapping between "Variant Option" and "Photo Group". Currently `photoGroupIds` is just a list.

**Current**:
```typescript
export interface ListingProposal {
  photoGroupIds: string[]; 
  variants: ListingVariant[]; // { itemId, option1Value }
  // ...
}
```

**Proposed**:
We need to know that "Blue" corresponds to `JAN:Blue`.
We can infer this if `option1Value` matches the suffix of the photo group key?
-   Photo Group: `454...:Blue`
-   Variant Option: `Blue`
-   Match!

### 3.3 Execution Plan
1.  Modify `generate_proposals` in `src/lib/listing-creation-slice.ts`.
2.  Parse keys from `photos.janCodeToPhotos`.
3.  Group them by Base JAN.
4.  If multiple groups exist for one Base JAN:
    -   Generate a proposal with multiple variants.
    -   Use the suffixes as `option1Value`.
    -   Assign the Base Inventory Item to the first variant.
    -   **Crucial**: The UI needs to handle "Splitting" the stock. Currently, the `Split` UI assumes we are splitting *existing* items. Here we effectively have "Unassigned Stock".
    -   For now, to satisfy the requirement "associated with the right image", we just need to ensure the **Photo Lookup** in the UI respects the subtype.

5.  **UI Update (`listing-detail`)**:
    -   Ensure `buildImagePickerCandidates` or the gallery renderer looks for `JAN:Subtype` keys if available.
    -   The `image-queue` or `SecureImage` doesn't care, it just takes URLs.
    -   The `ListingProposal` logic needs to pass the right keys.

### 3.4 Summary
The primary fix is in `generate_proposals`. It must stop ignoring `JAN:Subtype` keys and instead aggregate them into a single proposal for the Base JAN, pre-configured with variants matching those subtypes.
