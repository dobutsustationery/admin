import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import { update_item } from "$lib/inventory";

describe("Root reducer timestamp normalization", () => {
  it("normalizes createdAt into timestamp before reducer processing", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });

    const createdAt = { seconds: 1770000000, nanoseconds: 0 };
    const action = {
      ...update_item({
        id: "4542804044355",
        item: {
          janCode: "4542804044355",
          subtype: "",
          description: "Design Paper Square Astronomy",
          hsCode: "49090000",
          image: "https://cdn.example.com/image.png",
          qty: 12,
          pieces: 1,
          shipped: 0,
          creationDate: "Unknown",
          timestamp: 0,
        },
      }),
      createdAt,
      timestamp: undefined,
    } as any;

    state = rootReducer(state, action);

    expect(state.inventory.idToItem["4542804044355"].timestamp).toBe(
      createdAt.seconds * 1000,
    );
  });
});
