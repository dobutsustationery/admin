# Gemini Assistant Guide for `admin2` Repository

This document contains instructions and key information for me, the Gemini Assistant, to effectively work within this repository. It is based on the contents of the `/docs` directory.

## 1. Core Architectural Concepts

- **Event Sourcing:** The application's state is not stored directly but is reconstructed by replaying an append-only log of immutable actions.
  - **Source of Truth:** The `broadcast` collection in Firestore. Every significant state change is an action document in this collection.
  - **Implication:** To understand the current state, one must process the actions from the beginning. The `transfer-data.js` script is essential for getting this history into a local environment.

- **"Facts vs. Intent" Philosophy:**
  - **Green Actions (Good):** Represent raw, undeniable facts (e.g., `append_raw_rows` with raw CSV data) or direct user intent (e.g., `update_field`). These are safe to persist forever.
  - **Red Actions (Bad):** Represent derived data (e.g., `bulk_import_items` containing objects parsed from a CSV). The logic that created this data might change, making the "Red" action obsolete or incorrect.
  - **Goal:** The architecture is moving towards eliminating "Red" actions from the broadcast log. New features should only dispatch "Green" actions.

- **Listings vs. Inventory:**
  - **`Listing` (`listings-slice.ts`):** A product as it appears on Shopify. It has a `handle` and contains descriptive data like `title`, `bodyHtml`, and `images`. A listing groups one or more variants.
  - **`Item` (`inventory-slice.ts`):** A physical Stock Keeping Unit (SKU) in the warehouse. It has a `janCode` (barcode) and a `subtype`. It is linked to a `Listing` via its `handle` field.

- **Real-Time Synchronization:** All actions dispatched to the `broadcast` collection are observed by all connected clients, which then replay the action to update their local Redux state. This keeps all users in sync.

## 2. Key Workflows & Modules

### Development Environment Setup

- The project supports `local` (emulators), `staging`, and `production` environments.
- **Crucial First Step:** To work locally, the emulators must be populated with data from a real environment.
  1. Start emulators: `npm run emulators`
  2. In a separate terminal, transfer data: `npm run data:transfer -- --from production --to emulator`
  3. Start the dev server: `npm run dev:local`

### Product & Inventory Management

- **Product Import (from Photos):** This is the primary way new products are added.
  1. Staff take photos: a photo of the JAN barcode, followed by photos of the product.
  2. Photos are uploaded to a specific Google Photos album.
  3. The system processes the album, uses the barcode photo to group the subsequent product shots, and uses an LLM to generate a title and description.
- **Order Import (from Spreadsheets):** For bulk inventory updates from supplier invoices.
  1. User selects a spreadsheet from Google Drive.
  2. The system analyzes it, finds JAN codes and quantities, and creates an import plan.
- **Listing Creation:** A semi-automated, "gamified" UI for reviewing the items created from the photo import and creating Shopify listings from them in batches.

### Integrations

- **Shopify (`/shopify-products`, `/shopify-import`):** Manages syncing inventory counts to Shopify and creating Shopify product CSVs. The state is managed in the `listings` slice.
- **Google Drive (`/csv`, `google-drive.ts`):** Used for exporting inventory CSVs and for the Order Import workflow.
- **Google Photos (`/photos`, `google-photos.ts`):** Used for the photo-based product import workflow. The integration uses the Picker API, which is a more secure, user-driven flow.

### Testing

- **E2E Tests (`/e2e`):** The primary verification method. They use Playwright.
  - **Strict Standards:** Tests require screenshot-based verification with zero pixel tolerance, programmatic checks, and detailed `README.md` files that act as verification documents.
  - **Baselines:** Baseline screenshots are critical and must be updated when UI changes are intentional (`npx playwright test --update-snapshots`).
  - **Running Tests:** Use `npm run test:e2e`. The test runner scripts handle loading the necessary test data into the emulators.

## 3. Practical Instructions for Common Tasks

### When Adding a New Feature or Fixing a Bug:

1.  **Understand the Data Flow:** Is this related to `Inventory`, `Listings`, or another slice? Does it involve an external integration?
2.  **Follow Event Sourcing:**
    - Define new **"Green" actions** for any state changes. Avoid deriving data within the action payload itself.
    - If you need to orchestrate a complex change across multiple slices, use the **Root Reducer Composition** pattern described in `docs/design/EVENT_SOURCING_DESIGN.md`. Do not dispatch the orchestrating action to the broadcast middleware if it's "Red".
3.  **Update State:** Create or modify the appropriate Redux slice in `src/lib/`.
4.  **Build the UI:** Create or modify the Svelte components in `src/routes/`.
5.  **Write Tests:**
    - Create a new E2E test directory in `/e2e`.
    - Follow the structure and guidelines in `docs/testing/E2E_TEST_WRITING_STEPS.md`.
    - Ensure your test includes both visual and programmatic verification.
    - Generate the baseline screenshots.

### When Modifying Existing Code:

1.  **Check the Docs:** Look for a relevant design document in `/docs/design` or `/docs/integrations` to understand the original intent.
2.  **Respect the Architecture:** Adhere to the Event Sourcing and "Facts vs. Intent" principles. Do not introduce "Red" actions.
3.  **Run the Tests:** Run the relevant E2E tests to see if your changes have visual or functional impacts. If the changes are intentional, update the test baselines.

### When Running the Project for the First Time:

1.  **Install Dependencies:** `npm install`.
2.  **Set up Local Data:** Run `npm run emulators` and `npm run data:transfer -- --from production --to emulator`.
3.  **Run the App:** `npm run dev:local`.
4.  **Explore:** The UI overhaul introduced a proper navigation menu. Use it to explore the different sections of the app. The dashboard (`/`) is the main landing page.
