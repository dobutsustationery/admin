import { createAction, createReducer } from "@reduxjs/toolkit";

export interface NamesState {
  nameIdToNames: { [key: string]: string[] };
}

export const create_name = createAction<{ id: string; name: string }>(
  "create_name",
);
export const remove_name = createAction<{ id: string; name: string }>(
  "remove_name",
);

export const initialState: NamesState = {
  nameIdToNames: {},
};

export const names = createReducer(initialState, (r) => {
  r.addCase(create_name, (state, action) => {
    const { id, name } = action.payload;
    if (!state.nameIdToNames[id]) {
      state.nameIdToNames[id] = [];
    }
    state.nameIdToNames[id].push(name);
    state.nameIdToNames[id].sort();
  });
  r.addCase(remove_name, (state, action) => {
    const { id, name } = action.payload;
    if (!state.nameIdToNames[id]) {
      return;
    }
    state.nameIdToNames[id] = state.nameIdToNames[id].filter((x) => name !== x);
    state.nameIdToNames[id].sort();
  });
});
