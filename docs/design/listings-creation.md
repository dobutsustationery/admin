# Listings Creation Design Document

> **Status: Proposed**

## 1. Overview

This document outlines the design for the **Listings Creation** flow. This feature bridges the gap between **Imported Orders** (inventory items with quantities but no listing details) and **Shopify Listings** (public-facing product pages).

The goal is to provide a semi-automated, gamified workflow where users can review matched photos and inventory data to rapidly create high-quality product listings.

## 2. User Stories

1.  **As a User**, I want to see a "To-Do" list of items that have photos and inventory stock but no active listing, so I know what needs to be listed.
2.  **As a User**, I want the system to automatically propose a title, description, and category for these items based on the photos, so I don't have to write them from scratch.
3.  **As a User**, I want to review these proposals in small, manageable batches (e.g., 10 at a time) to avoid feeling overwhelmed.
4.  **As a User**, I want to easily assign "Subtypes" (e.g., Color, Style) if the item is a variant of a larger product family.
5.  **As a User**, I want a satisfying "done" moment (gamification) when I finish a batch, making the work feel rewarding.

## 3. User Experience (UX)

### 3.1 The "Listing Quest" (Gamification)

To prevent burnout, the infinite queue of unlisted items is broken down into **"Quests"** or **Batches**.

*   **Batch Size**: 10 Listings.
*   **Progress**: A distinct progress bar for the current batch (0/10).
*   **Completion**: When the 10th item is approved, a celebration animation plays (confetti, checkmark), and the user is returned to the dashboard with a "Batch Complete!" summary.

### 3.2 Review Interface

The review screen focuses on **one proposal at a time** (or a focused grid of the current batch).

**Layout:**
*   **Left**: Image Carousel (from matched Google Photos).
*   **Center**: Editable Listing Details.
    *   **Title**: Pre-filled by LLM.
    *   **Description**: Pre-filled by LLM (Rich Text).
    *   **Subtype/Variant**: Dropdown or Tags.
*   **Right**: Metadata & Actions.
    *   JAN Code, Current Stock, Estimated Price.
    *   **Actions**:
        *   ✅ **Approve** (Green): Publishes listing, moves to next.
        *   ✏️ **Edit**: Focus fields for manual entry.
        *   🗑️ **Discard/Skip**: Remover from key, or putting back in queue.

## 4. Technical Architecture

### 4.1 Data Flow

```mermaid
graph TD
    Inventory[Inventory Item] --> Matcher
    Photos[Analyzed Photos] --> Matcher
    Matcher -->|JAN Match| Proposals[Listing Proposals]
    
    subgraph "Listing Creation State"
        Proposals
        Batch[Current Batch (10)]
    end
    
    Batch -->|Review & Edit| UserAction
    UserAction -->|Approve| Listing[New Listing]
    UserAction -->|Approve| ItemUpdate[Update Item Handle]
```

### 4.2 State Management (`listing-creation-slice.ts`)

We will introduce a new Redux slice to manage the *ephemeral* state of proposals.

```typescript
interface ListingProposal {
  // Source Data
  janCode: string;
  inventoryItemIds: string[]; // Linked Inventory Items
  photoGroupIds: string[];    // Linked Photo Groups

  // Proposed Content (Editable)
  title: string;
  bodyHtml: string;
  productCategory: string;
  vendor: string;
  tags: string[];
  
  // Variant Config
  option1Name: string; // e.g. "Color"
  variants: {
    itemId: string;
    option1Value: string; // e.g. "Red"
  }[];
}

interface ListingCreationState {
  queue: string[]; // List of JAN codes ready for listing
  currentBatch: ListingProposal[];
  completedInBatch: number;
}
```

### 4.3 Proposal Generation Logic

The `generate_proposals` thunk/saga will:

1.  **Scan Inventory**: Find items where `handle` is missing.
2.  **Scan Photos**: Find `janCodeToPhotos` groups.
3.  **Intersect**: Identify JANs present in both.
4.  **LLM Enhancement**:
    *   If a description was already generated during Photo Import, reuse it.
    *   If not, trigger a new LLM call to generate Title/Body.
5.  **Grouping**:
    *   If multiple Inventory Items share a JAN (rare) or are marked as "Subtypes" of a common known parent, group them.
    *   *Self-Correction*: If the user previously merged JAN groups in Photos, we treat them as one Product with multiple Variants.

### 4.4 Event Sourcing Actions

*   `PROPOSE_BATCH_START`: Locks a set of JANs for the current user to avoid collisions.
*   `UPDATE_PROPOSAL`: Local edits to the proposal (title change, etc.).
*   `APPROVE_LISTING`:
    *   **Effect 1**: Dispatches `create_listing` (Listings Slice).
    *   **Effect 2**: Dispatches `update_item` for each variant to set the `handle`.
    *   **Effect 3**: Removes from `listingCreation` queue.

## 5. Integration Plan

1.  **Photos Route**: Add a "Create Listings" button in the Photos "Done" state.
2.  **Dashboard**: Add a "Listings to Review" widget showing the count of potential proposals.
3.  **Navigation**: New route `/listings/create`.

## 6. Open Questions

*   **Pricing**: Where does the price come from?
    *   *Answer*: It should be in the Inventory Item from the **Order Import** step. If missing, the Review UI must enforce price entry.
*   **Handle Generation**: How do we generate the URL handle?
    *   *Answer*: Auto-slugify the Title (e.g., "Cute Cat Pen" -> `cute-cat-pen`). Check for collisions and append suffix if needed.
