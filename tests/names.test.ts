import { describe, expect, it } from "vitest";
import { create_name, initialState, names, remove_name } from "$lib/names";

describe("names reducer", () => {
  it("can add a new name", () => {
    const id = "HSCode";
    const nextState = names(
      initialState,
      create_name({ id, name: "39199080" }),
    );
    expect(nextState.nameIdToNames[id].length).to.equal(1);
  });
  it("sorts names by default", () => {
    const id = "sorted";
    let nextState = initialState;
    nextState = names(nextState, create_name({ id, name: "last" }));
    expect(nextState.nameIdToNames[id].length).to.equal(1);
    expect(nextState.nameIdToNames[id][0]).to.equal("last");
    nextState = names(nextState, create_name({ id, name: "first" }));
    expect(nextState.nameIdToNames[id].length).to.equal(2);
    expect(nextState.nameIdToNames[id][0]).to.equal("first");
  });
  it("removes a name", () => {
    const id = "sorted";
    let nextState = initialState;
    nextState = names(nextState, create_name({ id, name: "last" }));
    nextState = names(nextState, create_name({ id, name: "first" }));
    expect(nextState.nameIdToNames[id].length).to.equal(2);
    nextState = names(nextState, remove_name({ id, name: "first" }));
    expect(nextState.nameIdToNames[id].length).to.equal(1);
  });
  it("does nothing when removing a name from non-existent id", () => {
    const id = "nonExistent";
    const nextState = names(
      initialState,
      remove_name({ id, name: "someName" }),
    );
    expect(nextState.nameIdToNames[id]).toBeUndefined();
  });
  it("sorts names after removal", () => {
    const id = "sortTest";
    let nextState = initialState;
    nextState = names(nextState, create_name({ id, name: "zebra" }));
    nextState = names(nextState, create_name({ id, name: "apple" }));
    nextState = names(nextState, create_name({ id, name: "middle" }));
    expect(nextState.nameIdToNames[id]).toEqual(["apple", "middle", "zebra"]);
    nextState = names(nextState, remove_name({ id, name: "middle" }));
    expect(nextState.nameIdToNames[id]).toEqual(["apple", "zebra"]);
  });
});
