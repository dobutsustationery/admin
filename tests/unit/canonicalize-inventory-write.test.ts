import { describe, expect, it, vi } from "vitest";

import { rootReducer } from "$lib/root-reducer";
import { update_item, package_item, type Item } from "$lib/inventory";

// docs/investigations/REPLAY_CONSOLE_ERRORS.md: the Shopify import writes
// a bare-JAN id while moving Option1 into item.subtype, so
// applyInventoryUpdate's canonical-key validator fired 93x on the Apr 25
// replay. The fix redirects the write to the canonical key AND migrates
// any pre-existing bare-JAN row (qty/shipped/history + order references)
// into it — same semantics as rename_subtype.

const JAN = "4902505660443";
const SUB = "Red";
const CANON = `${JAN}${SUB}`;

function withTs(action: any, seconds: number) {
  return { ...action, timestamp: { _seconds: seconds, _nanoseconds: 0 } };
}

const bareItem: Item = {
  janCode: JAN,
  subtype: "",
  description: "Ilmily Gel Pen",
  hsCode: "96081019",
  image: "",
  qty: 10,
  pieces: 1,
  shipped: 0,
  creationDate: "Jan 1, 2026",
  timestamp: 0,
};

describe("canonicalize-on-write inventory redirect + migrate", () => {
  it("redirects a bare-JAN subtyped write to the canonical key, migrating the stale row and order refs", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let state = rootReducer(undefined, { type: "@@INIT" });

      // 1. Bare-JAN inventory row exists (e.g. created by an order import).
      state = rootReducer(
        state,
        withTs(update_item({ id: JAN, item: bareItem }), 1_700_000_000) as any,
      );
      expect(state.inventory.idToItem[JAN]).toBeDefined();

      // 2. An order packs the bare-JAN key.
      state = rootReducer(
        state,
        withTs(
          package_item({ orderID: "ORD1", itemKey: JAN as any, qty: 2 }),
          1_700_000_100,
        ) as any,
      );
      const ord1Before = state.inventory.orderIdToOrder["ORD1"].items.map(
        (l: any) => l.itemKey,
      );
      expect(ord1Before).toContain(JAN);

      // 3. Shopify-import-style write: bare-JAN id, but item carries the
      //    Option1-derived subtype. qty is a 0 delta (ignoreShopifyQty).
      state = rootReducer(
        state,
        withTs(
          update_item({
            id: JAN,
            item: { ...bareItem, subtype: SUB, qty: 0 },
          }),
          1_700_000_200,
        ) as any,
      );

      // Canonical subtyped key now holds the row...
      const canon = state.inventory.idToItem[CANON];
      expect(canon).toBeDefined();
      expect(canon.subtype).toBe(SUB);
      expect(canon.qty).toBe(10); // migrated from the bare-JAN row (+0 delta)
      // ...and the stale bare-JAN row is gone.
      expect(state.inventory.idToItem[JAN]).toBeUndefined();

      // Order line was rewritten bare-JAN -> canonical.
      const ord1After = state.inventory.orderIdToOrder["ORD1"].items;
      expect(ord1After.find((l: any) => l.itemKey === JAN)).toBeUndefined();
      expect(ord1After.find((l: any) => l.itemKey === CANON)?.qty).toBe(2);

      // No InventoryValidation console.error was emitted.
      const validationErrors = errorSpy.mock.calls.filter((c) =>
        String(c[0]).includes("[InventoryValidation] Item update ID mismatch"),
      );
      expect(validationErrors).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("does not disturb a write whose id is already canonical", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });
    state = rootReducer(
      state,
      withTs(
        update_item({
          id: CANON,
          item: { ...bareItem, subtype: SUB },
        }),
        1_700_000_000,
      ) as any,
    );
    expect(state.inventory.idToItem[CANON]).toBeDefined();
    expect(state.inventory.idToItem[JAN]).toBeUndefined();
    expect(state.inventory.idToItem[CANON].qty).toBe(10);
  });
});
