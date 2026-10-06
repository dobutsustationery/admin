import { it, expect, vi } from "vitest";
import { get } from "svelte/store";
vi.mock("../../src/lib/firebase", () => ({ firestore: {} }));
import { createDraftJournal } from "../../src/lib/amazon-draft-journal";
const event = (revision: number) => ({
  type: "amazonPrepare/draftDecisionChanged",
  payload: {
    sellerId: "seller",
    owner: "user",
    revision,
    token: String(revision),
    itemKey: "item",
    field: "priceGBP",
    value: String(revision),
  },
});
function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) || null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
it("saves before network acknowledgement and recovers failed writes after navigation/reload", async () => {
  const disk = storage();
  const first = createDraftJournal(disk, "draft", async () => {
    throw Error("offline");
  });
  first.append(event(1));
  expect(JSON.parse(disk.getItem("draft")!)[0]).toEqual(event(1));
  await settle();
  expect(get(first).error).toBe("offline");
  const sent: any[] = [];
  const recovered = createDraftJournal(disk, "draft", async (e) => {
    sent.push(e);
  });
  await recovered.flush();
  expect(sent).toEqual([event(1)]);
  expect(get(recovered).events).toHaveLength(1);
  recovered.observed(1, "1");
  expect(JSON.parse(disk.getItem("draft")!)).toEqual([]);
});
it("sends an edit made while an earlier edit is still syncing", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const sent: number[] = [];
  const journal = createDraftJournal(storage(), "draft", async (e) => {
    if (e.payload.revision === 1) await wait;
    sent.push(e.payload.revision);
  });
  journal.append(event(1));
  journal.append(event(2));
  release();
  await settle();
  expect(sent).toEqual([1, 2]);
  journal.observed(1, "1");
  expect(get(journal).events.map((e) => e.payload.revision)).toEqual([2]);
});
it("does not claim an edit is saved when local storage fails", () => {
  const journal = createDraftJournal(
    {
      getItem: () => null,
      setItem: () => {
        throw Error("quota exceeded");
      },
    },
    "draft",
    async () => {},
  );
  expect(() => journal.append(event(1))).toThrow("quota exceeded");
  expect(get(journal).events).toHaveLength(0);
});
it("retains recovery data when local replay precedes server acknowledgement", async () => {
  const disk = storage();
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const journal = createDraftJournal(disk, "draft", () => pending);
  journal.append(event(1));
  journal.observed(1, "1");
  expect(JSON.parse(disk.getItem("draft")!)).toHaveLength(1);
  release();
  await settle();
  expect(JSON.parse(disk.getItem("draft")!)).toEqual([]);
});
