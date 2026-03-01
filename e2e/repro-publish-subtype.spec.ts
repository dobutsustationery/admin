import { test, expect } from "@playwright/test";
import { waitForAppReady } from "./helpers/loading-helper";

// Remove createTestUser as we don't need auth for direct store manipulation
const createTestUser = async (page: any) => {}; // Mock if needed or remove usage

test("Publishing a proposal saves Draft Subtype to Inventory", async ({
  page,
}) => {
  await createTestUser(page);

  const timestamp = Date.now();
  const janCode = `PUB${timestamp}`;
  const itemId = `item-${timestamp}`;

  // 1. Load App Environment
  await page.goto("/");
  page.on("console", (msg) => console.log("PAGE LOG:", msg.text()));
  await waitForAppReady(page);
  await page.waitForFunction(() => (window as any).testHelpers);

  // 2. Inject State & Execute Logic directly
  await page.evaluate(
    async ({ janCode, itemId }) => {
      const { store, actions } = (window as any).testHelpers;
      console.log("PAGE LOG: Actions available:", Object.keys(actions));

      // Setup Inventory (Old Subtype)
      store.dispatch(
        actions.bulk_import_items({
          items: [
            {
              id: itemId,
              item: {
                janCode,
                description: "Pub Product",
                qty: 5,
                subtype: "Old",
                handle: "",
                image: "",
              },
              type: "new",
            },
          ],
        }),
      );

      // Setup Proposal (New Subtype in Option Value)
      store.dispatch(
        actions.add_proposals([
          {
            janCode,
            inventoryItemIds: [itemId],
            photoGroupIds: [],
            title: "Pub Draft",
            bodyHtml: "",
            productCategory: "Test",
            vendor: "Test",
            tags: [],
            option1Name: "Subtype",
            variants: [{ itemId, option1Value: "New" }],
            status: "draft",
          },
        ]),
      );

      // Setup Photo state (mock empty) to avoid undefined errors if thunk checks keys
      // (state.photos.janCodeToPhotos is accessed in thunk)

      // EXECUTE THUNK DIRECTLY
      // This simulates clicking "Approve & Publish" without UI auth hurdle
      console.log("PAGE LOG: Dispatching approve_proposal_thunk");
      store.dispatch(actions.approve_proposal_thunk(janCode));
    },
    { janCode, itemId },
  );

  // 3. Verify Result (Poll for async update)
  await expect(async () => {
    const result = await page.evaluate(
      ({ itemId, janCode }) => {
        const { store } = (window as any).testHelpers;
        const inventory = store.getState().inventory.idToItem || {};
        const itemsForJan = Object.entries(inventory)
          .filter(([_, item]: any) => item?.janCode === janCode)
          .map(([id, item]: any) => ({ id, subtype: item?.subtype }));
        return {
          oldKeySubtype: inventory[itemId]?.subtype,
          itemsForJan,
        };
      },
      { itemId, janCode },
    );

    // Current approve flow re-keys the inventory item when subtype is set.
    expect(result.oldKeySubtype).toBeUndefined();
    expect(result.itemsForJan).toContainEqual(
      expect.objectContaining({ subtype: "New" }),
    );
  }).toPass({ timeout: 5000 });
});
