import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

import { rootReducer } from "$lib/root-reducer";
import { generateHandle } from "$lib/handle-utils";
import type { ListingProposal } from "$lib/listing-creation-slice";
import type { ListingImage } from "$lib/listings-slice";

function expectedDraftImageIdsAtApproval(
  proposals: ListingProposal[],
  primary: ListingProposal,
  photosState: any,
): string[] {
  const groupIds = new Set<string>();
  const excludedIds = new Set<string>();

  proposals.forEach((p: any) => {
    (p.photoGroupIds || []).forEach((gid: string) => groupIds.add(gid));
    (p.variants || []).forEach((v: any) => {
      if (v.photoGroupKey) groupIds.add(v.photoGroupKey);
    });
    (p.excludedPhotoIds || []).forEach((id: string) => excludedIds.add(id));
  });

  const janToPhotos = photosState?.janCodeToPhotos || {};
  const seenPhotoIds = new Set<string>();
  const photoImages: any[] = [];

  groupIds.forEach((gid) => {
    const pPhotos = janToPhotos[gid] || [];
    pPhotos.forEach((ph: any) => {
      if (seenPhotoIds.has(ph.id) || excludedIds.has(ph.id)) return;
      seenPhotoIds.add(ph.id);
      photoImages.push({
        id: ph.id,
        url: ph.baseUrl || ph.productUrl || ph.url,
      });
    });
  });

  const listingOnly: any[] = proposals.flatMap((p: any) =>
    (p.listingOnlyImages || []).map((img: any) => ({
      ...img,
      isListingOnly: true,
      sourceJan: p.janCode,
    })),
  );

  let merged: any[] = [...photoImages, ...listingOnly];

  const order = primary.listingImageOrder || [];
  if (order.length > 0) {
    const byId = new Map(merged.map((img) => [img.id, img]));
    const ordered: any[] = [];
    order.forEach((id: string) => {
      const hit = byId.get(id);
      if (!hit) return;
      ordered.push(hit);
      byId.delete(id);
    });
    merged = [...ordered, ...Array.from(byId.values())];
  }

  // No dedupe: preserve exact ordered image list (including duplicates).
  return merged.map((img) => img.id);
}

describe("Replay Kalita Minimal Photo Order", () => {
  it("keeps approved listing image order aligned with exact draft image order", () => {
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

        const mergedProposals = Object.values(
          state.listingCreation.proposals,
        ).filter((p: any) => {
          const h = p.handle || generateHandle(p.title, p.janCode);
          if (h === finalHandle) return true;
          if (!p.handle && !proposal.handle && p.janCode === proposal.janCode) {
            return true;
          }
          return false;
        }) as ListingProposal[];

        const primaryIndex = mergedProposals.findIndex(
          (p) => p.janCode === proposal.janCode,
        );
        if (primaryIndex > 0) {
          mergedProposals.splice(primaryIndex, 1);
          mergedProposals.unshift(proposal as ListingProposal);
        }

        const expectedIds = expectedDraftImageIdsAtApproval(
          mergedProposals,
          proposal as ListingProposal,
          state.photos,
        );

        state = rootReducer(state, action);

        const createdListing = state.listings.handleToListing[finalHandle];
        expect(createdListing).toBeDefined();
        const actualIds = (createdListing.images || []).map(
          (img: ListingImage) => img.id,
        );

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
