import { describe, expect, it, beforeAll } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { setAutoFreeze } from "immer";
import { rootReducer as _rootReducer } from "../../src/lib/root-reducer";
// Fixtures omit the per-action timestamp that every replayed action
// carries in production; stamp one (deriveCreationTimestampMs fails
// loudly on a missing timestamp).
const rootReducer = (s: any, a: any) =>
  _rootReducer(
    s,
    a && typeof a === "object" && a.type && !("timestamp" in a)
      ? { ...a, timestamp: { _seconds: 1_700_000_000, _nanoseconds: 0 } }
      : a,
  );
import {
  set_proposal_handle_thunk,
  add_proposals_internal,
  add_variant_requested,
  remove_variant_requested,
  update_variant_qty,
  update_proposal_field,
  type ListingProposal,
} from "../../src/lib/listing-creation-slice";
import { bulk_import_items, update_field } from "../../src/lib/inventory";

describe("Listing Creation - Variants & Merging", () => {
  beforeAll(() => {
    setAutoFreeze(false);
  });

  it("should merge two proposals when their handles are set to the same value", () => {
    const store = configureStore({ reducer: rootReducer });

    // 1. Setup two separate proposals
    const janA = "jan_a";
    const janB = "jan_b";

    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      handle: "handle-a",
      variants: [{ id: "v-a", itemId: janA, option1Value: "Default", qty: 5 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // 2. Set handle of B to match A
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "handle-a") as any,
    );

    // 3. Verify they merged
    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have two variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(2);
    expect(state.proposals[janA].inventoryItemIds).toContain(janA);
    expect(state.proposals[janA].inventoryItemIds).toContain(janB);
  });

  it("should merge a proposal into another even if one doesn't have an explicit handle set", () => {
    const store = configureStore({ reducer: rootReducer });

    // 1. Setup two separate proposals
    const janA = "jan_a";
    const janB = "jan_b";

    // Proposal A has NO handle set, so it will use computed handle
    // generateHandle("Product A", "jan_a") -> "product-a-jan_a"
    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      variants: [{ id: "v-a", itemId: janA, option1Value: "Default", qty: 5 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // 2. Set handle of B to match A's computed handle
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "product-a-jan_a") as any,
    );

    // 3. Verify they merged
    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have two variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(2);
  });

  it("should merge a single-variant proposal into a multi-variant proposal", () => {
    const store = configureStore({ reducer: rootReducer });

    const janA = "jan_a";
    const janB = "jan_b";

    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      handle: "shared-handle",
      variants: [
        { id: "v-a1", itemId: janA, option1Value: "Red", qty: 5 },
        { id: "v-a2", itemId: janA, option1Value: "Blue", qty: 5 },
      ],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // Set handle of B to match A
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "shared-handle") as any,
    );

    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have three variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(3);
  });

  describe("Intent Actions (Add/Remove Requested)", () => {
    it("should add a new variant to the same JAN (splitting)", () => {
      const store = configureStore({ reducer: rootReducer });
      const jan = "jan_a";
      const variantId = "new-v-id";

      store.dispatch(
        add_proposals_internal([
          {
            janCode: jan,
            inventoryItemIds: ["item_a"],
            photoGroupIds: [jan],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "Default", qty: 10 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // Request adding variant to same JAN
      store.dispatch(
        add_variant_requested({ targetJan: jan, janCode: jan, variantId }),
      );

      const state = store.getState().listingCreation;
      expect(state.proposals[jan].variants.length).toBe(2);
      expect(state.proposals[jan].variants[1].id).toBe(variantId);
      expect(state.proposals[jan].variants[1].itemId).toBe("item_a");
    });

    it("should add a new variant from a different JAN (linking)", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";
      const variantId = "new-v-id";

      // 1. Setup inventory for JAN B (unlisted)
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                subtype: "Blue",
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal for JAN A
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a"],
            photoGroupIds: [janA],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "Red", qty: 10 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request adding variant from JAN B
      store.dispatch(
        add_variant_requested({ targetJan: janA, janCode: janB, variantId }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // Proposal should have new variant
      expect(creationState.proposals[janA].variants.length).toBe(2);
      expect(creationState.proposals[janA].variants[1].itemId).toBe("item_b");
      expect(creationState.proposals[janA].inventoryItemIds).toContain(
        "item_b",
      );

      // Inventory item should NOT have the handle linked yet (it is still a draft)
      expect(inventoryState.idToItem["item_b"].handle).toBeFalsy();
    });

    it("should allow 'stealing' a variant from another listing", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";
      const variantId = "steal-v-id";

      // 1. Setup inventory for JAN B (already listed elsewhere)
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                subtype: "Blue",
                handle: "other-handle",
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal for JAN A
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a"],
            photoGroupIds: [janA],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "Red", qty: 10 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request adding variant from JAN B (which is currently on 'other-handle')
      store.dispatch(
        add_variant_requested({ targetJan: janA, janCode: janB, variantId }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // Proposal should have new variant
      expect(creationState.proposals[janA].variants.length).toBe(2);
      expect(creationState.proposals[janA].variants[1].itemId).toBe("item_b");

      // Inventory item should STILL HAVE THE OLD HANDLE (transfer happens on approve)
      expect(inventoryState.idToItem["item_b"].handle).toBe("other-handle");
    });

    it("should remove a variant and NOT clear inventory handle in draft mode", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";

      // 1. Setup inventory with items linked to handle-a
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_a",
              item: {
                janCode: janA,
                handle: "handle-a",
                qty: 5,
                description: "A",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                subtype: "Default",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                handle: "handle-a",
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                subtype: "Default",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal with two variants
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a", "item_b"],
            photoGroupIds: [janA, janB],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "A", qty: 5 },
              { id: "v-b", itemId: "item_b", option1Value: "B", qty: 5 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request removal of variant B
      store.dispatch(
        remove_variant_requested({ janCode: janA, variantId: "v-b" }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // Proposal should only have variant A
      expect(creationState.proposals[janA].variants.length).toBe(1);
      expect(creationState.proposals[janA].variants[0].id).toBe("v-a");
      expect(creationState.proposals[janA].inventoryItemIds).not.toContain(
        "item_b",
      );

      // Inventory item B should STILL have its handle (we don't mutate live data in drafts)
      expect(inventoryState.idToItem["item_b"].handle).toBe("handle-a");
    });

    it("should resolve replayed variant actions by itemId and option value when generated ids differ", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "4542804151466";
      const importedJan = "4542804151572";

      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: [importedJan],
            photoGroupIds: [janA, importedJan],
            title: "Merged Product",
            handle: "amifa-aquarium-mini-card-4542804151572",
            variants: [
              {
                id: `${importedJan}:Default:replay-generated`,
                itemId: importedJan,
                option1Value: "Default",
                qty: 20,
              },
              {
                id: `${importedJan}:Dolphin:replay-generated`,
                itemId: importedJan,
                option1Value: "Dolphin",
                qty: 40,
              },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      store.dispatch(
        update_variant_qty({
          janCode: janA,
          variantId: `${importedJan}:Dolphin:historical-runtime-id`,
          qty: 10,
        }),
      );
      store.dispatch(
        add_variant_requested({
          targetJan: janA,
          janCode: importedJan,
          variantId: `${importedJan}:Penguin:new-runtime-id`,
          sourceVariantId: `${importedJan}:Dolphin:historical-runtime-id`,
          subtype: "Penguin",
          qty: 10,
        }),
      );
      store.dispatch(
        remove_variant_requested({
          janCode: janA,
          variantId: `${importedJan}:Default:historical-runtime-id`,
        }),
      );

      const variants =
        store.getState().listingCreation.proposals[janA].variants;
      expect(variants).toHaveLength(2);
      expect(variants[0].option1Value).toBe("Dolphin");
      expect(variants[0].qty).toBe(10);
      expect(variants[1].itemId).toBe(importedJan);
      expect(variants[1].option1Value).toBe("Penguin");
      expect(variants[1].qty).toBe(10);
    });

    it("should prefer bringing in a new item over splitting existing when JAN matches", () => {
      const store = configureStore({ reducer: rootReducer });
      const jan = "jan_match";
      const variantId = "new-v-id";

      // 1. Setup inventory with one listed and one unlisted item of same JAN
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_listed",
              item: {
                janCode: jan,
                handle: "handle-a",
                qty: 5,
                description: "A",
                hsCode: "1",
                pieces: 1,
                shipped: 0,
                subtype: "Default",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
            {
              type: "new",
              id: "item_unlisted",
              item: {
                janCode: jan,
                qty: 10,
                description: "B",
                hsCode: "2",
                pieces: 1,
                shipped: 0,
                subtype: "New Stock",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal for the already listed item
      store.dispatch(
        add_proposals_internal([
          {
            janCode: jan,
            inventoryItemIds: ["item_listed"],
            photoGroupIds: [jan],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-1", itemId: "item_listed", option1Value: "Old", qty: 5 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request adding variant with same JAN
      store.dispatch(
        add_variant_requested({ targetJan: jan, janCode: jan, variantId }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // SHOULD HAVE BROUGHT IN item_unlisted INSTEAD OF SPLITTING item_listed
      expect(creationState.proposals[jan].variants.length).toBe(2);
      expect(creationState.proposals[jan].variants[1].itemId).toBe(
        "item_unlisted",
      );
      // NOTE: In draft mode, inventory handle is NOT synced yet.
      expect(inventoryState.idToItem["item_unlisted"].handle).toBeFalsy();
    });

    it("should allow splitting from a non-primary JAN that was previously merged in", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";
      const vId3 = "split-v-id";

      // 1. Setup proposal with two items from different JANs
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a", "item_b"],
            photoGroupIds: [janA, janB],
            title: "Merged Product",
            handle: "merged",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "A", qty: 5 },
              { id: "v-b", itemId: "item_b", option1Value: "B", qty: 5 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 2. Ensure item_b record exists in inventory
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                subtype: "B",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 3. Request adding variant with janB (which is in variants but NOT the primary janA)
      // Since no other janB items are in inventory, it should SPLIT from item_b.
      store.dispatch(
        add_variant_requested({
          targetJan: janA,
          janCode: janB,
          variantId: vId3,
        }),
      );

      const creationState = store.getState().listingCreation;
      expect(creationState.proposals[janA].variants.length).toBe(3);
      expect(creationState.proposals[janA].variants[2].itemId).toBe("item_b");
      expect(creationState.proposals[janA].variants[2].id).toBe(vId3);
    });

    it("should result in identical state when replaying intent actions from scratch", () => {
      const createStore = () =>
        configureStore({
          reducer: rootReducer,
          middleware: (getDefault) =>
            getDefault({
              immutableCheck: false,
              serializableCheck: false,
            }),
        });
      const storeA = createStore();
      const storeB = createStore();

      const janA = "jan_a";
      const janB = "jan_b";
      const vId1 = "v-id-1";
      const vId2 = "v-id-2";

      const actions = [
        // 1. Initial Inventory
        {
          ...bulk_import_items({
            items: [
              {
                type: "new",
                id: "item_a",
                item: {
                  janCode: janA,
                  qty: 10,
                  description: "A",
                  hsCode: "1",
                  pieces: 1,
                  shipped: 0,
                  subtype: "Default",
                  image: "",
                  creationDate: "",
                  timestamp: 0,
                },
              },
              {
                type: "new",
                id: "item_b",
                item: {
                  janCode: janB,
                  qty: 5,
                  description: "B",
                  hsCode: "2",
                  pieces: 1,
                  shipped: 0,
                  subtype: "Default",
                  image: "",
                  creationDate: "",
                  timestamp: 0,
                },
              },
            ],
          }),
          timestamp: 1000,
        },
        // 2. Initial Proposal
        {
          ...add_proposals_internal([
            {
              janCode: janA,
              inventoryItemIds: ["item_a"],
              photoGroupIds: [janA],
              title: "Product A",
              handle: "product-a-jan_a",
              variants: [
                {
                  id: vId1,
                  itemId: "item_a",
                  option1Value: "Default",
                  qty: 10,
                },
              ],
              status: "draft",
              bodyHtml: "",
              productCategory: "",
              vendor: "",
              tags: [],
              option1Name: "Subtype",
            },
          ]),
          timestamp: 2000,
        },
        // 2.5 Ensure item_a is linked (simulating what add_proposals interceptor would do)
        {
          ...update_field({
            id: "item_a",
            field: "handle",
            from: "",
            to: "product-a-jan_a",
          }),
          timestamp: 3000,
        },
        // 3. Add variant from JAN B
        {
          ...add_variant_requested({
            targetJan: janA,
            janCode: janB,
            variantId: vId2,
          }),
          timestamp: 4000,
        },
        // 4. Update a field
        {
          ...update_proposal_field({
            janCode: janA,
            field: "title",
            value: "New Title",
          }),
          timestamp: 5000,
        },
        // 5. Remove original variant
        {
          ...remove_variant_requested({ janCode: janA, variantId: vId1 }),
          timestamp: 6000,
        },
      ];

      // Apply all actions to store A
      actions.forEach((a) => storeA.dispatch(a));

      // Replay all actions to store B
      actions.forEach((a) => storeB.dispatch(JSON.parse(JSON.stringify(a))));

      const stateA = JSON.parse(JSON.stringify(storeA.getState()));
      const stateB = JSON.parse(JSON.stringify(storeB.getState()));

      // Assert deep equality of relevant slices
      expect(stateA.listingCreation).toEqual(stateB.listingCreation);
      expect(stateA.inventory).toEqual(stateB.inventory);

      // Sanity checks on the final state
      expect(stateA.listingCreation.proposals[janA].title).toBe("New Title");
      expect(stateA.listingCreation.proposals[janA].variants.length).toBe(1);
      expect(stateA.listingCreation.proposals[janA].variants[0].id).toBe(vId2);

      // NOTE: item_a was in proposal, then removed. Handle should still be its starting value.
      expect(stateA.inventory.idToItem["item_a"].handle).toBe(
        "product-a-jan_a",
      );
      // NOTE: item_b was added to proposal. Handle should NOT be synced yet in draft mode.
      expect(stateA.inventory.idToItem["item_b"].handle).toBeFalsy();
    });
  });
});
