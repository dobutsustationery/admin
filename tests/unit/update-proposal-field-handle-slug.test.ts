import { describe, expect, it } from "vitest";

import { rootReducer } from "$lib/root-reducer";
import {
  add_proposals,
  update_proposal_field,
} from "$lib/listing-creation-slice";

// docs/investigations/PROPOSAL_HANDLE_NOT_SLUGIFIED.md: the production
// burst on JAN 4969757171813 stored a free-form title in proposal.handle
// because the reducer wrote whatever the operator typed verbatim. After
// the fix, the same payload should produce a slug-shaped canonical handle.

const JAN = "4969757171813";
const FREE_FORM_HANDLE = "Kyowa Kawaii Puppy Dog Love & Fur Sticky Notes (75)";
const CANONICAL_FOR_FREE_FORM = `kyowa-kawaii-puppy-dog-love-fur-sticky-notes-75-${JAN}`;

function seed() {
  let state = rootReducer(undefined, { type: "@@INIT" });
  state = rootReducer(
    state,
    add_proposals([
      {
        janCode: JAN,
        photoGroupIds: [],
        title: "Dobutsu Love & Fur Dog Sticky Notes",
        bodyHtml: "",
        productCategory: "Stationery",
        vendor: "Dobutsu",
        tags: [],
        option1Name: "Subtype",
        variants: [],
        photoGroupKey: JAN,
      } as any,
    ]) as any,
  );
  return state;
}

describe("update_proposal_field — handle canonicalization", () => {
  it("slugifies a title-shaped value typed into the handle field", () => {
    let state = seed();
    state = rootReducer(
      state,
      update_proposal_field({
        janCode: JAN,
        field: "handle",
        value: FREE_FORM_HANDLE,
      } as any) as any,
    );
    expect(state.listingCreation.proposals[JAN].handle).toBe(
      CANONICAL_FOR_FREE_FORM,
    );
  });

  it("leaves an already-canonical slug unchanged", () => {
    let state = seed();
    state = rootReducer(
      state,
      update_proposal_field({
        janCode: JAN,
        field: "handle",
        value: CANONICAL_FOR_FREE_FORM,
      } as any) as any,
    );
    expect(state.listingCreation.proposals[JAN].handle).toBe(
      CANONICAL_FOR_FREE_FORM,
    );
  });

  it("does not slugify other fields (title still accepts free text)", () => {
    let state = seed();
    const messyTitle = "Kyowa Love & Fur Mini Sticky Notes (75)";
    state = rootReducer(
      state,
      update_proposal_field({
        janCode: JAN,
        field: "title",
        value: messyTitle,
      } as any) as any,
    );
    expect(state.listingCreation.proposals[JAN].title).toBe(messyTitle);
  });
});
