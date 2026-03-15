import { describe, expect, it } from "vitest";
import reducer, {
  complete_batch,
  mark_celebrated,
  start_batch,
} from "$lib/listing-creation-slice";

describe("Listing Creation - Celebration Gate", () => {
  it("keeps hasCelebrated=true after completion until the next start_batch", () => {
    const started = reducer(
      undefined,
      start_batch({
        janCodes: ["JAN-1"],
        batchId: "batch-1",
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

  it("resets celebration gate only on start_batch", () => {
    const startedFirst = reducer(
      undefined,
      start_batch({
        janCodes: ["JAN-1"],
        batchId: "batch-1",
      }),
    );
    const completedFirst = reducer(startedFirst, complete_batch());
    const celebratedFirst = reducer(completedFirst, mark_celebrated());
    expect(celebratedFirst.hasCelebrated).toBe(true);

    const startedSecond = reducer(
      celebratedFirst,
      start_batch({
        janCodes: ["JAN-2"],
        batchId: "batch-2",
      }),
    );
    expect(startedSecond.hasCelebrated).toBe(false);
  });
});
