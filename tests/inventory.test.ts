import { describe, expect, it } from "vitest";
import {
  archive_inventory,
  delete_empty_order,
  hide_archive,
  initialState,
  inventory,
  make_sales,
  new_order,
  package_item,
  quantify_item,
  rename_subtype,
  retype_item,
  update_field,
  update_item,
  type Item,
} from "$lib/inventory";

describe("inventory reducer", () => {
  describe("update_item", () => {
    it("adds a new item to the inventory", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      const nextState = inventory(initialState, update_item({ id, item }));
      expect(nextState.idToItem[id]).toBeDefined();
      expect(nextState.idToItem[id].qty).toBe(10);
      expect(nextState.idToItem[id].shipped).toBe(0);
      
      // Test immutability: modifying the original item shouldn't affect state
      item.qty = 5;
      expect(nextState.idToItem[id].qty).toBe(10);
    });

    it("accumulates quantities when updating existing item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      expect(nextState.idToItem[id].qty).toBe(10);

      const item2 = { ...item, qty: 5 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));
      expect(nextState.idToItem[id].qty).toBe(15);
    });

    it("accumulates shipped quantities when updating existing item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Green",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      expect(nextState.idToItem[id].shipped).toBe(2);

      const item2 = { ...item, qty: 5, shipped: 3 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));
      expect(nextState.idToItem[id].shipped).toBe(5);
    });

    it("ensures shipped is defined in state", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Yellow",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      const nextState = inventory(initialState, update_item({ id, item }));
      expect(nextState.idToItem[id].shipped).toBeDefined();
      expect(nextState.idToItem[id].shipped).toBe(0);
    });

    it("creates history entry for new item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Purple",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      const nextState = inventory(initialState, update_item({ id, item }));
      expect(nextState.idToHistory[id]).toBeDefined();
      expect(nextState.idToHistory[id].length).toBe(1);
    });
  });

  describe("update_field", () => {
    it("updates a field in an existing item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Original Description",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      nextState = inventory(
        nextState,
        update_field({
          id,
          field: "description",
          from: "Original Description",
          to: "Updated Description",
        }),
      );
      expect(nextState.idToItem[id].description).toBe("Updated Description");
    });

    it("updates qty field", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      nextState = inventory(
        nextState,
        update_field({ id, field: "qty", from: 10, to: 5 }),
      );
      expect(nextState.idToItem[id].qty).toBe(5);
    });

    it("creates history entry for field update", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Green",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      const initialHistoryLength = nextState.idToHistory[id].length;

      nextState = inventory(
        nextState,
        update_field({ id, field: "qty", from: 10, to: 8 }),
      );
      expect(nextState.idToHistory[id].length).toBe(initialHistoryLength + 1);
    });

    it("handles qty field set to 0", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Yellow",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      nextState = inventory(
        nextState,
        update_field({ id, field: "qty", from: 10, to: 0 }),
      );
      expect(nextState.idToItem[id].qty).toBe(0);
      // Item should still exist even when qty is 0 (based on TODO comment)
      expect(nextState.idToItem[id]).toBeDefined();
    });
  });

  describe("new_order", () => {
    it("creates a new order", () => {
      const orderID = "ORDER-001";
      const nextState = inventory(
        initialState,
        new_order({
          orderID,
          date: new Date("2024-01-01"),
          email: "test@example.com",
          product: "Test Product",
        }),
      );
      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
      expect(nextState.orderIdToOrder[orderID].id).toBe(orderID);
      expect(nextState.orderIdToOrder[orderID].email).toBe("test@example.com");
      expect(nextState.orderIdToOrder[orderID].product).toBe("Test Product");
      expect(nextState.orderIdToOrder[orderID].items).toEqual([]);
    });

    it("preserves existing order items when updating order", () => {
      const orderID = "ORDER-002";
      let nextState = inventory(
        initialState,
        new_order({
          orderID,
          date: new Date("2024-01-01"),
          email: "test@example.com",
          product: "Test Product",
        }),
      );

      // Add an item to the order
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      nextState = inventory(nextState, update_item({ id, item }));
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 2 }),
      );

      // Update the order
      nextState = inventory(
        nextState,
        new_order({
          orderID,
          date: new Date("2024-01-02"),
          email: "updated@example.com",
          product: "Updated Product",
        }),
      );

      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
      expect(nextState.orderIdToOrder[orderID].email).toBe(
        "updated@example.com",
      );
    });
  });

  describe("package_item", () => {
    it("adds a new item to an order", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 2 }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
      expect(nextState.orderIdToOrder[orderID].items[0].itemKey).toBe(id);
      expect(nextState.orderIdToOrder[orderID].items[0].qty).toBe(2);
    });

    it("increments shipped quantity for packaged item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 3 }),
      );

      expect(nextState.idToItem[id].shipped).toBe(3);
    });

    it("accumulates quantity for existing item in order", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Green",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 2 }),
      );
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 3 }),
      );

      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
      expect(nextState.orderIdToOrder[orderID].items[0].qty).toBe(5);
      expect(nextState.idToItem[id].shipped).toBe(5);
    });

    it("creates order if it doesn't exist", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Yellow",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "NEW-ORDER";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 1 }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
    });

    it("creates history entry for packaged item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Purple",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      const initialHistoryLength = nextState.idToHistory[id].length;

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 2 }),
      );

      expect(nextState.idToHistory[id].length).toBe(initialHistoryLength + 1);
    });
  });

  describe("quantify_item", () => {
    it("adds an item to an order with specific quantity", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 5 }),
      );

      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
      expect(nextState.orderIdToOrder[orderID].items[0].qty).toBe(5);
      expect(nextState.idToItem[id].shipped).toBe(5);
    });

    it("updates quantity for existing item in order", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 3 }),
      );
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 7 }),
      );

      expect(nextState.orderIdToOrder[orderID].items.length).toBe(1);
      expect(nextState.orderIdToOrder[orderID].items[0].qty).toBe(7);
      expect(nextState.idToItem[id].shipped).toBe(7);
    });

    it("removes item from order when qty is set to 0", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Green",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 5 }),
      );
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 0 }),
      );

      expect(nextState.orderIdToOrder[orderID].items.length).toBe(0);
    });

    it("creates history entry for quantified item", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Yellow",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      const initialHistoryLength = nextState.idToHistory[id].length;

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 4 }),
      );

      expect(nextState.idToHistory[id].length).toBeGreaterThan(
        initialHistoryLength,
      );
    });

    it("creates order if it doesn't exist", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Purple",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "NEW-ORDER";
      nextState = inventory(
        nextState,
        quantify_item({ orderID, itemKey: id, qty: 2 }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
    });
  });

  describe("retype_item", () => {
    it("changes item type in an order", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id1, qty: 3 }),
      );

      nextState = inventory(
        nextState,
        retype_item({
          orderID,
          itemKey: id1,
          janCode: item2.janCode,
          subtype: item2.subtype,
          qty: 3,
        }),
      );

      expect(
        nextState.orderIdToOrder[orderID].items.find((i) => i.itemKey === id1),
      ).toBeUndefined();
      expect(
        nextState.orderIdToOrder[orderID].items.find((i) => i.itemKey === id2),
      ).toBeDefined();
      expect(nextState.idToItem[id1].shipped).toBe(0);
      expect(nextState.idToItem[id2].shipped).toBe(3);
    });

    it("accumulates quantity when retyping to existing item in order", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id1, qty: 3 }),
      );
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id2, qty: 5 }),
      );

      nextState = inventory(
        nextState,
        retype_item({
          orderID,
          itemKey: id1,
          janCode: item2.janCode,
          subtype: item2.subtype,
          qty: 3,
        }),
      );

      const blueItem = nextState.orderIdToOrder[orderID].items.find(
        (i) => i.itemKey === id2,
      );
      expect(blueItem?.qty).toBe(8);
    });

    it("creates history entries for both items", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id1, qty: 3 }),
      );

      const initialHistory1Length = nextState.idToHistory[id1].length;
      const initialHistory2Length = nextState.idToHistory[id2].length;

      nextState = inventory(
        nextState,
        retype_item({
          orderID,
          itemKey: id1,
          janCode: item2.janCode,
          subtype: item2.subtype,
          qty: 3,
        }),
      );

      expect(nextState.idToHistory[id1].length).toBe(initialHistory1Length + 1);
      expect(nextState.idToHistory[id2].length).toBe(initialHistory2Length + 1);
    });

    it("creates order if it doesn't exist", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      const orderID = "NEW-ORDER";
      nextState = inventory(
        nextState,
        retype_item({
          orderID,
          itemKey: id1,
          janCode: item2.janCode,
          subtype: item2.subtype,
          qty: 2,
        }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
    });

    it("handles retyping to same item key", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 3 }),
      );

      // Retype to the same item (should trigger console.error)
      nextState = inventory(
        nextState,
        retype_item({
          orderID,
          itemKey: id,
          janCode: item.janCode,
          subtype: item.subtype,
          qty: 3,
        }),
      );

      // Item should remain in order since it's the same key
      expect(
        nextState.orderIdToOrder[orderID].items.find((i) => i.itemKey === id),
      ).toBeDefined();
    });
  });

  describe("rename_subtype", () => {
    it("renames an item's subtype", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id, subtype: "Blue" }),
      );

      const newId = `${item.janCode}Blue`;
      expect(nextState.idToItem[newId]).toBeDefined();
      expect(nextState.idToItem[newId].subtype).toBe("Blue");
      expect(nextState.idToItem[newId].qty).toBe(10);
      expect(nextState.idToItem[id].qty).toBe(0);
      expect(nextState.idToItem[id].shipped).toBe(0);
    });

    it("merges quantities when renaming to existing subtype with identical item", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 5,
        pieces: 1,
        shipped: 1,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id1, subtype: "Blue" }),
      );

      expect(nextState.idToItem[id2].qty).toBe(15);
      expect(nextState.idToItem[id2].shipped).toBe(3);
      expect(nextState.idToItem[id1].qty).toBe(0);
      expect(nextState.idToItem[id1].shipped).toBe(0);
    });

    it("does not merge when items are not identical", () => {
      const item1: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Different Description",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const item2: Item = {
        janCode: "4901234567890",
        subtype: "Blue",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 5,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id1 = `${item1.janCode}${item1.subtype}`;
      const id2 = `${item2.janCode}${item2.subtype}`;

      let nextState = inventory(initialState, update_item({ id: id1, item: item1 }));
      nextState = inventory(nextState, update_item({ id: id2, item: item2 }));

      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id1, subtype: "Blue" }),
      );

      // Should not merge because descriptions differ
      expect(nextState.idToItem[id1].qty).toBe(10);
      expect(nextState.idToItem[id2].qty).toBe(5);
    });

    it("updates order references to the new item key", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 3 }),
      );

      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id, subtype: "Blue" }),
      );

      const newId = `${item.janCode}Blue`;
      expect(
        nextState.orderIdToOrder[orderID].items.find(
          (i) => i.itemKey === newId,
        ),
      ).toBeDefined();
      expect(
        nextState.orderIdToOrder[orderID].items.find((i) => i.itemKey === id),
      ).toBeUndefined();
    });

    it("does nothing when renaming to the same subtype", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const beforeState = nextState;
      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id, subtype: "Red" }),
      );

      expect(nextState.idToItem[id].qty).toBe(beforeState.idToItem[id].qty);
      expect(nextState.idToItem[id].shipped).toBe(
        beforeState.idToItem[id].shipped,
      );
    });

    it("creates history entries for both old and new items", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      nextState = inventory(
        nextState,
        rename_subtype({ itemKey: id, subtype: "Blue" }),
      );

      const newId = `${item.janCode}Blue`;
      expect(nextState.idToHistory[id]).toBeDefined();
      expect(nextState.idToHistory[newId]).toBeDefined();
    });
  });

  describe("delete_empty_order", () => {
    it("deletes an order with no items", () => {
      const orderID = "ORDER-001";
      let nextState = inventory(
        initialState,
        new_order({
          orderID,
          date: new Date("2024-01-01"),
          email: "test@example.com",
          product: "Test Product",
        }),
      );

      nextState = inventory(
        nextState,
        delete_empty_order({ orderID }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeUndefined();
    });

    it("does not delete an order with items", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const orderID = "ORDER-001";
      nextState = inventory(
        nextState,
        package_item({ orderID, itemKey: id, qty: 2 }),
      );

      nextState = inventory(
        nextState,
        delete_empty_order({ orderID }),
      );

      expect(nextState.orderIdToOrder[orderID]).toBeDefined();
    });

    it("does nothing for non-existent order", () => {
      const nextState = inventory(
        initialState,
        delete_empty_order({ orderID: "NON-EXISTENT" }),
      );

      expect(nextState).toEqual(initialState);
    });
  });

  describe("archive_inventory", () => {
    it("creates an archive of current inventory", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      expect(nextState.archivedInventoryState[archiveName]).toBeDefined();
      expect(
        nextState.archivedInventoryState[archiveName].idToItem[id],
      ).toBeDefined();
      expect(nextState.archivedInventoryDate[archiveName]).toBeDefined();
    });

    it("zeros out current inventory quantities after archiving", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      expect(nextState.idToItem[id].qty).toBe(0);
      expect(nextState.idToItem[id].shipped).toBe(0);
      expect(
        nextState.archivedInventoryState[archiveName].idToItem[id].qty,
      ).toBe(10);
      expect(
        nextState.archivedInventoryState[archiveName].idToItem[id].shipped,
      ).toBe(2);
    });

    it("creates history entries for archived items", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));
      const initialHistoryLength = nextState.idToHistory[id].length;

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      expect(nextState.idToHistory[id].length).toBe(initialHistoryLength + 1);
    });

    it("initializes history for items without prior history during archiving", () => {
      // Manually create a state with an item but no history
      const item: Item = {
        janCode: "4901234567890",
        subtype: "NoHistory",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 2,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      
      // Create state with item but no history
      const stateWithoutHistory = {
        ...initialState,
        idToItem: { [id]: item },
        idToHistory: {}, // No history for this item
      };

      const archiveName = "Archive-2024-01";
      const nextState = inventory(
        stateWithoutHistory,
        archive_inventory({ archiveName }),
      );

      expect(nextState.idToHistory[id]).toBeDefined();
      expect(nextState.idToHistory[id].length).toBeGreaterThan(0);
    });
  });

  describe("hide_archive", () => {
    it("moves an archive to hidden state", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      nextState = inventory(nextState, hide_archive({ archiveName }));

      expect(nextState.archivedInventoryState[archiveName]).toBeUndefined();
      expect(nextState.hiddenInventoryState[archiveName]).toBeDefined();
    });

    it("does nothing for non-existent archive", () => {
      const nextState = inventory(
        initialState,
        hide_archive({ archiveName: "NON-EXISTENT" }),
      );

      expect(nextState).toEqual(initialState);
    });
  });

  describe("make_sales", () => {
    it("creates a sales event from an archive", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      // Add some more inventory after archiving
      const item2 = { ...item, qty: 3 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));

      const saleDate = new Date("2024-02-01");
      nextState = inventory(
        nextState,
        make_sales({ archiveName, date: saleDate }),
      );

      expect(nextState.salesEvents[archiveName]).toBeDefined();
      expect(nextState.salesEvents[archiveName].id).toBe(archiveName);
      expect(nextState.salesEvents[archiveName].items.length).toBeGreaterThan(0);
    });

    it("calculates sales quantities correctly", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      // Remaining inventory is 3
      const item2 = { ...item, qty: 3 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));

      const saleDate = new Date("2024-02-01");
      nextState = inventory(
        nextState,
        make_sales({ archiveName, date: saleDate }),
      );

      const salesItem = nextState.salesEvents[archiveName].items.find(
        (i) => i.itemKey === id,
      );
      expect(salesItem).toBeDefined();
      expect(salesItem?.qty).toBe(7); // 10 - 3 = 7 sold
    });

    it("excludes items with zero sales quantity", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      // Add back the same quantity (no sales)
      const item2 = { ...item, qty: 10 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));

      const saleDate = new Date("2024-02-01");
      nextState = inventory(
        nextState,
        make_sales({ archiveName, date: saleDate }),
      );

      const salesItem = nextState.salesEvents[archiveName].items.find(
        (i) => i.itemKey === id,
      );
      expect(salesItem).toBeUndefined(); // No sales, so item shouldn't be in sales event
    });

    it("handles items with multiple pieces", () => {
      const item: Item = {
        janCode: "4901234567890",
        subtype: "Red",
        description: "Test Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 5,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      // Add some inventory back
      const item2 = { ...item, qty: 3 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));

      const saleDate = new Date("2024-02-01");
      nextState = inventory(
        nextState,
        make_sales({ archiveName, date: saleDate }),
      );

      expect(nextState.salesEvents[archiveName].items.length).toBeGreaterThan(0);
    });

    it("handles specific debug case for item 4542804104370", () => {
      const item: Item = {
        janCode: "4542804104370",
        subtype: "Test",
        description: "Debug Item",
        hsCode: "49090000",
        image: "http://example.com/image.jpg",
        qty: 10,
        pieces: 1,
        shipped: 0,
        creationDate: "2024-01-01",
      };
      const id = `${item.janCode}${item.subtype}`;
      let nextState = inventory(initialState, update_item({ id, item }));

      const archiveName = "Archive-2024-01";
      nextState = inventory(
        nextState,
        archive_inventory({ archiveName }),
      );

      // Add some inventory back
      const item2 = { ...item, qty: 3 };
      nextState = inventory(nextState, update_item({ id, item: item2 }));

      const saleDate = new Date("2024-02-01");
      nextState = inventory(
        nextState,
        make_sales({ archiveName, date: saleDate }),
      );

      // This triggers the debug console.log for items starting with "4542804104370"
      expect(nextState.salesEvents[archiveName]).toBeDefined();
    });
  });
});
