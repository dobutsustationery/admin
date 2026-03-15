import type { CaseReducer, PayloadAction } from "@reduxjs/toolkit";
import type { TimestampedAction } from "./timestamped-action";

export type TimestampedPayloadAction<
  Payload = void,
  Type extends string = string,
> = PayloadAction<Payload, Type> & TimestampedAction;

export const withTimestamp = <
  State,
  Payload = void,
  Type extends string = string,
>(
  reducer: (
    state: State,
    action: TimestampedPayloadAction<Payload, Type>,
  ) => void,
): CaseReducer<State, PayloadAction<Payload, Type>> => {
  return (state, action) =>
    reducer(state as State, action as TimestampedPayloadAction<Payload, Type>);
};
