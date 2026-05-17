import { describe, it, expect } from "vitest";
import { deriveCreationTimestampMs } from "$lib/timestamped-action";

// Single source of truth for "when was this created": derive from the
// action timestamp, never parse a formatted creationDate string. Fails
// loudly when the timestamp is absent (a programming error).

describe("deriveCreationTimestampMs", () => {
  it("resolves every timestamp shape used in the codebase", () => {
    expect(deriveCreationTimestampMs(1_700_000_000_000)).toBe(
      1_700_000_000_000,
    );
    expect(deriveCreationTimestampMs({ seconds: 1_700, nanoseconds: 0 })).toBe(
      1_700_000,
    );
    expect(
      deriveCreationTimestampMs({ _seconds: 1_700, _nanoseconds: 0 }),
    ).toBe(1_700_000);
    const d = new Date("2024-10-09T00:00:00Z");
    expect(deriveCreationTimestampMs({ toDate: () => d })).toBe(d.getTime());
  });

  it("throws loudly when the timestamp is not set", () => {
    expect(() => deriveCreationTimestampMs(undefined)).toThrow(
      /timestamp not set/,
    );
    expect(() => deriveCreationTimestampMs(null)).toThrow(/timestamp not set/);
    expect(() => deriveCreationTimestampMs({} as any)).toThrow(
      /timestamp not set/,
    );
    expect(() => deriveCreationTimestampMs(0)).toThrow(/timestamp not set/);
  });
});
