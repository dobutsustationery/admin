import { describe, expect, it } from "vitest";

import { rootReducer as _rootReducer } from "$lib/root-reducer";
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
import { update_field, update_item, type Item } from "$lib/inventory";

// onConfirmAddVariant in src/routes/listing-detail/+page.svelte's live-mode
// branch dispatches three update_field actions against the same itemId. When
// itemId is a bare JAN row and the burst includes a subtype change, the
// subtype update re-keys the inventory item and any *later* action against
// the original itemId silently no-ops (see audit row 15, 2026-03-29 burst on
// `4542804123579`).
//
// This test verifies that placing qty before subtype in the burst keeps the
// qty edit on the canonical key, and that the inverse order silently drops
// it. Acts on rootReducer directly so it stays fast and self-contained.

const JAN = "4542804123579";
const NEW_HANDLE =
  "amifa-masterpiece-collection-a4-collage-paper-8-15-4542804123555";
const NEW_SUBTYPE = "Transparent";
const SEED_QTY = 24;
const NEW_QTY = 12;

const seedItem: Item = {
  janCode: JAN,
  subtype: "",
  description: "Amifa Masterpiece Collection",
  hsCode: "48114190",
  image: "",
  qty: SEED_QTY,
  pieces: 1,
  shipped: 0,
  creationDate: "Jan 1, 2026",
  timestamp: 0,
};

function seedState() {
  let state = rootReducer(undefined, { type: "@@INIT" });
  state = rootReducer(state, update_item({ id: JAN, item: seedItem }) as any);
  return state;
}

function qtyOnCanonical(state: any) {
  return state.inventory.idToItem[`${JAN}${NEW_SUBTYPE}`]?.qty;
}

function bareStillExists(state: any) {
  return !!state.inventory.idToItem[JAN];
}

describe("onConfirmAddVariant dispatch ordering", () => {
  it("regression baseline: handle → subtype → qty drops the qty edit", () => {
    let state = seedState();
    expect(state.inventory.idToItem[JAN]?.qty).toBe(SEED_QTY);

    // Original (broken) order.
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "handle",
        from: "",
        to: NEW_HANDLE,
      }) as any,
    );
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "subtype",
        from: "",
        to: NEW_SUBTYPE,
      }) as any,
    );
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "qty",
        from: SEED_QTY,
        to: NEW_QTY,
      }) as any,
    );

    expect(bareStillExists(state)).toBe(false);
    // Bug: qty edit silently no-ops because the subtype update already
    // re-keyed the item away from the bare JAN.
    expect(qtyOnCanonical(state)).toBe(SEED_QTY);
  });

  it("with the fix: handle → qty → subtype lands the qty on the renamed key", () => {
    let state = seedState();

    // Fixed order: subtype LAST so the re-key happens after qty.
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "handle",
        from: "",
        to: NEW_HANDLE,
      }) as any,
    );
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "qty",
        from: SEED_QTY,
        to: NEW_QTY,
      }) as any,
    );
    state = rootReducer(
      state,
      update_field({
        id: JAN,
        field: "subtype",
        from: "",
        to: NEW_SUBTYPE,
      }) as any,
    );

    expect(bareStillExists(state)).toBe(false);
    expect(qtyOnCanonical(state)).toBe(NEW_QTY);
  });
});
