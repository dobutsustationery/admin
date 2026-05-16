import { describe, it, expect } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  update_field,
  update_fields,
  update_item,
  type Item,
} from "$lib/inventory";

// update_fields must be byte-identical to dispatching update_field once
// per entry, in order (same idToItem write + same idToHistory entries).
// This underpins the approve_proposal fan-out collapse in root-reducer
// (docs/investigations/REPLAY_PERFORMANCE.md).

const TS = { _seconds: 1_700_000_000, _nanoseconds: 0 };

function seed(): any {
  let s = rootReducer(undefined, { type: "@@INIT" });
  const item: Item = {
    janCode: "4900000000001",
    subtype: "Blue",
    description: "Seed",
    hsCode: "",
    image: "",
    qty: 5,
    pieces: 1,
    shipped: 0,
    creationDate: "",
    timestamp: 0,
  };
  s = rootReducer(s, {
    ...update_item({ id: "4900000000001Blue", item }),
    timestamp: TS,
  } as any);
  return s;
}

const FIELDS: {
  field: keyof Item;
  from: string | number;
  to: string | number;
}[] = [
  { field: "price", from: "", to: 4.5 },
  { field: "handle", from: "", to: "my-handle-4900000000001" },
  { field: "description", from: "", to: "Updated Desc" },
  { field: "image", from: "", to: "https://example.com/a.png" },
  { field: "imagePosition", from: "", to: 2 },
];

const ID = "4900000000001Blue";

describe("update_fields ≡ sequential update_field", () => {
  it("produces identical idToItem and idToHistory", () => {
    let seq = seed();
    for (const f of FIELDS) {
      seq = rootReducer(seq, {
        ...update_field({ id: ID, field: f.field, from: f.from, to: f.to }),
        timestamp: TS,
      } as any);
    }

    let batch = seed();
    batch = rootReducer(batch, {
      ...update_fields({ id: ID, fields: FIELDS }),
      timestamp: TS,
    } as any);

    expect(batch.inventory.idToItem[ID]).toEqual(seq.inventory.idToItem[ID]);
    expect(batch.inventory.idToHistory[ID]).toEqual(
      seq.inventory.idToHistory[ID],
    );
  });

  it("no-ops on a missing item (same as update_field)", () => {
    let s = seed();
    const before = JSON.stringify(s.inventory.idToItem);
    s = rootReducer(s, {
      ...update_fields({
        id: "9999999999999Ghost",
        fields: [{ field: "price", from: "", to: 1 }],
      }),
      timestamp: TS,
    } as any);
    expect(JSON.stringify(s.inventory.idToItem)).toBe(before);
  });

  it("applies numeric coercion for qty/price like update_field", () => {
    let s = seed();
    s = rootReducer(s, {
      ...update_fields({
        id: ID,
        fields: [
          { field: "price", from: "", to: "7.25" },
          { field: "qty", from: "", to: "9" },
        ],
      }),
      timestamp: TS,
    } as any);
    expect(s.inventory.idToItem[ID].price).toBe(7.25);
    expect(s.inventory.idToItem[ID].qty).toBe(9);
  });
});
