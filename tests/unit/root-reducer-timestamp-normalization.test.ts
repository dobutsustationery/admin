import { describe, expect, it } from "vitest";
import { rootReducer, toTimestampMs } from "$lib/root-reducer";
import { update_field } from "$lib/inventory";

describe("Root reducer timestamp normalization", () => {
  it("converts timestamp objects with millisecond precision from nanoseconds", () => {
    expect(
      toTimestampMs({ seconds: 1770000000, nanoseconds: 123_000_000 }),
    ).toBe(1770000000123);
    expect(
      toTimestampMs({ _seconds: 1770000000, _nanoseconds: 456_000_000 }),
    ).toBe(1770000000456);
  });

  it("preserves millisecond precision from createdAt nanoseconds", () => {
    let state = rootReducer(undefined, { type: "@@INIT" });

    const createdAtFirst = { seconds: 1770000000, nanoseconds: 123_000_000 };
    const createdAtSecond = { seconds: 1770000001, nanoseconds: 456_000_000 };

    state = rootReducer(state, {
      ...update_field({
        id: "123A",
        field: "description",
        from: "",
        to: "x",
      }),
      createdAt: createdAtFirst,
    } as any);

    state = rootReducer(state, {
      ...update_field({
        id: "123 A",
        field: "description",
        from: "",
        to: "y",
      }),
      createdAt: createdAtSecond,
    } as any);

    const collision = state.keyAudit.canonicalCollisions["123A"];
    expect(collision).toBeDefined();
    expect(collision.lastSeenAtMs).toBe(createdAtSecond.seconds * 1000 + 456);
  });
});
