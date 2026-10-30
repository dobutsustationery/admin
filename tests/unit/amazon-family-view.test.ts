import { describe, expect, it } from "vitest";
import {
  amazonCreationFamilies,
  amazonFamilyStatus,
} from "../../src/lib/amazon-family-view";
import type { PreparationRow } from "../../src/lib/amazon-preparation";
const rows = (): PreparationRow[] =>
  ["Blue", "Pink"].map(
    (subtype) =>
      ({
        row: {
          key: subtype,
          family: "stickers",
          title: "Amifa 3D Aurora Stickers",
          jan: "4542804116359",
          subtype,
          asin: "",
          onHand: 4,
        },
        decision: {},
        entry: null,
        reason: "Shared JAN",
      }) as PreparationRow,
  );
const listings = { stickers: { title: "Amifa 3D Aurora Stickers" } };
describe("one product-level Amifa family view", () => {
  it("groups shared JAN variants once and treats an unprepared family as a new listing", () => {
    const members = rows(),
      groups = amazonCreationFamilies(members, listings);
    expect(groups.size).toBe(1);
    expect(groups.get("stickers")).toHaveLength(2);
    expect(amazonFamilyStatus(members, {}, "seller", 100)).toBe("New listings");
  });
  it("keeps verified existing-ASIN offers, exclusions and products without a local listing in the existing workflow", () => {
    const members = rows();
    expect(amazonCreationFamilies(members, {}).size).toBe(0);
    members[0].row.asin = "B012345678";
    expect(amazonCreationFamilies(members, listings).size).toBe(0);
    members[0].row.asin = "";
    members[0].offerMatch = { candidates: [{ asin: "B012345678" }] } as any;
    expect(amazonCreationFamilies(members, listings).size).toBe(0);
    members[0].offerMatch = undefined;
    members[0].decision.included = false;
    expect(amazonCreationFamilies(members, listings).size).toBe(0);
  });
  it("reports family validation and publication as one operation", () => {
    const members = rows();
    const parent: any = {
      id: "p",
      sellerId: "seller",
      createdAt: 100,
      updatedAt: 100,
      status: "ready",
      entry: { family: { handle: "stickers", role: "parent" } },
      validation: { status: 200, data: { status: "VALID" } },
    };
    const jobs: any = {
      p: parent,
      b: {
        ...parent,
        id: "b",
        parentJobId: "p",
        entry: { family: { handle: "stickers", role: "child" } },
      },
      c: {
        ...parent,
        id: "c",
        parentJobId: "p",
        entry: { family: { handle: "stickers", role: "child" } },
      },
    };
    expect(amazonFamilyStatus(members, jobs, "seller", 200)).toBe(
      "Ready to publish",
    );
    jobs.b.status = "publish_queued";
    expect(amazonFamilyStatus(members, jobs, "seller", 200)).toBe(
      "In progress",
    );
    jobs.b.status = "blocked";
    expect(amazonFamilyStatus(members, jobs, "seller", 200)).toBe("Failed");
    expect(amazonFamilyStatus(members, jobs, "other-seller", 200)).toBe(
      "New listings",
    );
  });
});
