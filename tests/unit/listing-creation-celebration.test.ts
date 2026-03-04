import { describe, expect, it } from "vitest";
import reducer, {
  complete_batch,
  mark_celebrated,
  start_batch,
} from "$lib/listing-creation-slice";

describe("Listing Creation - Celebration Gate", () => {
  it("does not reset hasCelebrated on duplicate complete_batch with no active batch", () => {
    const started = reducer(
      undefined,
      start_batch({
        janCodes: ["JAN-1"],
        batchId: "batch-1",
        createdAt: 1,
      }),
    );

    const completed = reducer(started, complete_batch());
    expect(completed.lastCompletedBatchId).toBe("batch-1");
    expect(completed.hasCelebrated).toBe(false);

    const celebrated = reducer(completed, mark_celebrated());
    expect(celebrated.hasCelebrated).toBe(true);

    const duplicateComplete = reducer(celebrated, complete_batch());
    expect(duplicateComplete.lastCompletedBatchId).toBe("batch-1");
    expect(duplicateComplete.hasCelebrated).toBe(true);
  });

  it("resets celebration gate for a brand new batch completion", () => {
    const base = reducer(undefined, { type: "@@INIT" });
    const withPreviousCelebration = reducer(base, mark_celebrated());

    const startedNext = reducer(
      withPreviousCelebration,
      start_batch({
        janCodes: ["JAN-2"],
        batchId: "batch-2",
        createdAt: 2,
      }),
    );
    expect(startedNext.hasCelebrated).toBe(false);

    const completedNext = reducer(startedNext, complete_batch());
    expect(completedNext.lastCompletedBatchId).toBe("batch-2");
    expect(completedNext.hasCelebrated).toBe(false);
  });
});
