import { createAction, createReducer } from "@reduxjs/toolkit";

export interface GhostSourceRecord {
  ghostId: string;
  canonicalId: string;
  janCode: string;
  oldSubtype: string;
  newSubtype: string;
  renamedAtMs: number;
  renamedByActionType: string;
}

export interface GhostAccessEvent {
  id: string;
  atMs: number;
  actionType: string;
  actionPath: string;
  requestedId: string;
  canonicalCandidate?: string;
  knownGhost: boolean;
  mappedCanonicalId?: string;
  outcome: "missing" | "found_under_canonical" | "found_raw";
}

export interface CanonicalCollisionReport {
  canonicalId: string;
  incomingIds: string[];
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  lastActionType: string;
  occurrences: number;
}

export interface KeyAuditState {
  ghostMap: { [ghostId: string]: GhostSourceRecord };
  ghostAccessEvents: GhostAccessEvent[];
  canonicalIncomingIndex: {
    [canonicalId: string]: { [incomingId: string]: true };
  };
  canonicalCollisions: { [canonicalId: string]: CanonicalCollisionReport };
}

export const initialState: KeyAuditState = {
  ghostMap: {},
  ghostAccessEvents: [],
  canonicalIncomingIndex: {},
  canonicalCollisions: {},
};

export const key_audit_register_ghost = createAction<GhostSourceRecord>(
  "keyAudit/register_ghost",
);

export const key_audit_record_ghost_access = createAction<GhostAccessEvent>(
  "keyAudit/record_ghost_access",
);

export const key_audit_observe_canonical = createAction<{
  atMs: number;
  actionType: string;
  incomingId: string;
  canonicalId: string;
}>("keyAudit/observe_canonical");

export const keyAudit = createReducer(initialState, (builder) => {
  builder
    .addCase(key_audit_register_ghost, (state, action) => {
      state.ghostMap[action.payload.ghostId] = action.payload;
    })
    .addCase(key_audit_record_ghost_access, (state, action) => {
      state.ghostAccessEvents.push(action.payload);
    })
    .addCase(key_audit_observe_canonical, (state, action) => {
      const { canonicalId, incomingId, atMs, actionType } = action.payload;
      if (!canonicalId || !incomingId) return;

      if (!state.canonicalIncomingIndex[canonicalId]) {
        state.canonicalIncomingIndex[canonicalId] = {};
      }
      state.canonicalIncomingIndex[canonicalId][incomingId] = true;

      const incomingIds = Object.keys(
        state.canonicalIncomingIndex[canonicalId],
      ).sort();
      if (incomingIds.length <= 1) return;

      const existing = state.canonicalCollisions[canonicalId];
      if (!existing) {
        state.canonicalCollisions[canonicalId] = {
          canonicalId,
          incomingIds,
          firstSeenAtMs: atMs,
          lastSeenAtMs: atMs,
          lastActionType: actionType,
          occurrences: 1,
        };
        return;
      }

      existing.incomingIds = incomingIds;
      existing.lastSeenAtMs = atMs;
      existing.lastActionType = actionType;
      existing.occurrences += 1;
    });
});
