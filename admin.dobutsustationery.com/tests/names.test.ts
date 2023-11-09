import { names, create_name, initialState, remove_name } from "$lib/names";
import { describe, expect, it } from "vitest";

describe("names reducer", () => {
  it("can add a new name", () => {
    const id = "HSCode";
    const nextState = names(initialState, create_name({id, name: "39199080"}))
    expect(nextState.nameIdToNames[id].length).to.equal(1);
  });
  it("sorts names by default", () => {
    const id = "sorted";
    let nextState = initialState;
    nextState = names(nextState, create_name({id, name: "last"}))
    expect(nextState.nameIdToNames[id].length).to.equal(1);
    expect(nextState.nameIdToNames[id][0]).to.equal("last");
    nextState = names(nextState, create_name({id, name: "first"}))
    expect(nextState.nameIdToNames[id].length).to.equal(2);
    expect(nextState.nameIdToNames[id][0]).to.equal("first");
  });
  it("removes a name", () => {
    const id = "sorted";
    let nextState = initialState;
    nextState = names(nextState, create_name({id, name: "last"}))
    nextState = names(nextState, create_name({id, name: "first"}))
    expect(nextState.nameIdToNames[id].length).to.equal(2);
    nextState = names(nextState, remove_name({id, name: "first"}))
    expect(nextState.nameIdToNames[id].length).to.equal(1);
  });
});
