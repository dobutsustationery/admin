import { describe, expect, it } from "vitest";
import { canonicalizeHandle, generateHandle } from "$lib/handle-utils";

const JAN = "4969757171813";

describe("canonicalizeHandle", () => {
  it("slugifies title-shaped free text and appends -<jan>", () => {
    expect(
      canonicalizeHandle("Kyowa Love & Fur Mini Sticky Notes (75)", JAN),
    ).toBe(`kyowa-love-fur-mini-sticky-notes-75-${JAN}`);
  });

  it("returns an already-canonical slug unchanged (no double-append)", () => {
    const canonical = `kyowa-love-fur-mini-sticky-notes-75-${JAN}`;
    expect(canonicalizeHandle(canonical, JAN)).toBe(canonical);
  });

  it("matches generateHandle for plain titles", () => {
    expect(canonicalizeHandle("Hello World", JAN)).toBe(
      generateHandle("Hello World", JAN),
    );
  });

  it("passes through a clean slug unchanged (preserves multi-JAN shared listings)", () => {
    // Multiple JANs intentionally sharing one Shopify handle (e.g. the
    // five "uni-propus-window-highlighter" colors) rely on the slug NOT
    // having a -<jan> suffix appended.
    expect(canonicalizeHandle("uni-propus-window-highlighter", JAN)).toBe(
      "uni-propus-window-highlighter",
    );
    expect(canonicalizeHandle("my-cute-pup", JAN)).toBe("my-cute-pup");
  });

  it("rejects almost-clean slugs that contain uppercase or spaces", () => {
    expect(canonicalizeHandle("My-Cute-Pup", JAN)).toBe(`my-cute-pup-${JAN}`);
    expect(canonicalizeHandle("my cute pup", JAN)).toBe(`my-cute-pup-${JAN}`);
  });

  it("trims, lowercases, and collapses whitespace + punctuation", () => {
    expect(canonicalizeHandle("  AmiFA  Mini --  Sticker (Red)  ", JAN)).toBe(
      `amifa-mini-sticker-red-${JAN}`,
    );
  });

  it("treats empty input as empty so callers fall back to generateHandle()", () => {
    expect(canonicalizeHandle("", JAN)).toBe("");
    expect(canonicalizeHandle("   ", JAN)).toBe("");
  });

  it("passes the bare JAN through unchanged (it's a valid slug)", () => {
    expect(canonicalizeHandle(JAN, JAN)).toBe(JAN);
  });
});
