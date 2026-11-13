import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const { lookupWithRetry } = createRequire(import.meta.url)(
  "../../functions/shared/amazon-catalog-lookup.cjs",
);
describe("bulk catalogue lookup throttling", () => {
  it("retries transient failures before recording the final response", async () => {
    const perform = vi
      .fn()
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValue({ status: 200 });
    const pause = vi.fn();
    expect(await lookupWithRetry(perform, pause)).toEqual({ status: 200 });
    expect(pause.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });
  it("retains a repeated failure as an actionable API result", async () => {
    const perform = vi.fn().mockResolvedValue({ status: 429 });
    expect(await lookupWithRetry(perform, vi.fn())).toEqual({ status: 429 });
    expect(perform).toHaveBeenCalledTimes(4);
  });
  it("does not retry missing permissions or a verified no-match", async () => {
    const perform = vi.fn().mockResolvedValue({ status: 403 }),
      pause = vi.fn();
    expect(await lookupWithRetry(perform, pause)).toEqual({ status: 403 });
    expect(perform).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
  });
});
