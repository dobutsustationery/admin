import { createReducer } from "@reduxjs/toolkit";

interface HistoryState {
  executedActions: Record<string, boolean>;
}

const initialState: HistoryState = {
  executedActions: {}
};

export const history = createReducer(initialState, (builder) => {
  builder.addMatcher(
    (action): action is any => !!(action && action.id),
    (state, action) => {
      if (!state.executedActions) {
          state.executedActions = {};
      }
      state.executedActions[action.id] = true;
    }
  );
});
