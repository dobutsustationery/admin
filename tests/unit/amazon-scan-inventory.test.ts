import { describe, it, expect } from "vitest";
import { scanInventoryJans } from "../../src/lib/amazon-scan-inventory";
const a = "4542804044355",
  b = "4542804061659";
describe("ASIN inventory stock selection", () => {
  it("defaults to positive stock after shipping", () => {
    expect(
      scanInventoryJans({
        a: { janCode: a, qty: 5, shipped: 5 },
        b: { janCode: b, qty: 3, shipped: 2 },
      }),
    ).toEqual([b]);
  });
  it("excludes zero, negative and unknown stock", () => {
    expect(
      scanInventoryJans({
        a: { janCode: a, qty: 0 },
        b: { janCode: b, qty: -1 },
        c: { janCode: a },
      }),
    ).toEqual([]);
  });
  it("allows opting into all stock levels but still validates barcodes", () => {
    expect(
      scanInventoryJans(
        { a: { janCode: a, qty: 0 }, b: { janCode: "invalid", qty: 1 } },
        true,
      ),
    ).toEqual([a]);
  });
  it("includes a shared JAN if any variant is available, once", () => {
    expect(
      scanInventoryJans({
        a: { janCode: a, qty: 0 },
        b: { janCode: a, qty: 2 },
        c: { janCode: a, qty: 3 },
      }),
    ).toEqual([a]);
  });
  it("picks up a previously skipped item after restocking", () => {
    const items = { a: { janCode: a, qty: 0 } };
    expect(scanInventoryJans(items)).toEqual([]);
    items.a.qty = 2;
    expect(scanInventoryJans(items)).toEqual([a]);
  });
});
