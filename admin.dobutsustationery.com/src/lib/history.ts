import { createReducer } from "@reduxjs/toolkit";

const initialState = {};
export const history = createReducer(initialState, (r) => {
  r.addDefaultCase((state, action) => {
    const printaction = { ...action };
    printaction.payload = { ...printaction.payload };
    printaction.payload.item = { ...printaction.payload.item };
    delete printaction.payload.item.image;
    //console.log(action.type, JSON.stringify(printaction));
  });
});
