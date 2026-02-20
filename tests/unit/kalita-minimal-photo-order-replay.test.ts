import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";
import { buildDraftListingImages } from "$lib/listing-image-logic";
import { generateHandle } from "$lib/handle-utils";

describe("Replay Kalita Minimal Photo Order", () => {
  it("keeps approved listing image order aligned with draft image order", () => {
    const filePath = join(
      process.cwd(),
      "test-data",
      "kalita-minimal-photo-order.jsonl",
    );
    const content = readFileSync(filePath, "utf-8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    let state = rootReducer(undefined, { type: "INIT" });
    let approvalCount = 0;

    for (const line of lines) {
      const action = JSON.parse(line);

      if (action.type === "listingCreation/approve_proposal") {
        const janCode = action.payload?.janCode;
        const proposal = state.listingCreation.proposals[janCode];
        expect(proposal).toBeDefined();

        const finalHandle =
          proposal.handle || generateHandle(proposal.title, proposal.janCode);

        const mergedProposals = Object.values(state.listingCreation.proposals)
          .filter((p: any) => {
            const h = p.handle || generateHandle(p.title, p.janCode);
            if (h === finalHandle) return true;
            if (
              !p.handle &&
              !proposal.handle &&
              p.janCode === proposal.janCode
            ) {
              return true;
            }
            return false;
          }) as any[];

        const primaryIndex = mergedProposals.findIndex(
          (p) => p.janCode === proposal.janCode,
        );
        if (primaryIndex > 0) {
          mergedProposals.splice(primaryIndex, 1);
          mergedProposals.unshift(proposal);
        }

        const expectedDraftImages = buildDraftListingImages(
          mergedProposals as any,
          state.photos,
          state.inventory,
        );
        const expectedIds = expectedDraftImages.map((img) => img.id);

        state = rootReducer(state, action);

        const createdListing = state.listings.handleToListing[finalHandle];
        expect(createdListing).toBeDefined();
        const actualIds = (createdListing.images || []).map((img: any) => img.id);

        expect(
          actualIds,
          `image order mismatch for handle=${finalHandle} jan=${janCode}`,
        ).toEqual(expectedIds);

        approvalCount += 1;
      } else {
        state = rootReducer(state, action);
      }
    }

    expect(approvalCount).toBeGreaterThan(0);
  });
});

