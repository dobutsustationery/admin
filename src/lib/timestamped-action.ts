export interface FirestoreTimestamp {
  seconds: number;
  nanoseconds: number;
}

export interface FirestoreTimestampLegacy {
  _seconds: number;
  _nanoseconds: number;
}

export type FirestoreTimestampLike =
  | FirestoreTimestamp
  | FirestoreTimestampLegacy
  | { toDate: () => Date }
  | number
  | null
  | undefined;

export interface TimestampedAction {
  id?: string;
  timestamp: FirestoreTimestamp;
  _timestamp: number;
}

const msToFirestoreTimestamp = (ms: number): FirestoreTimestamp => {
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const seconds = Math.floor(safeMs / 1000);
  const remainderMs = safeMs - seconds * 1000;
  return {
    seconds,
    nanoseconds: Math.max(0, Math.floor(remainderMs * 1_000_000)),
  };
};

export const toTimestampMs = (ts: FirestoreTimestampLike): number | null => {
  if (typeof ts === "number") return ts;

  if (typeof (ts as FirestoreTimestamp | undefined)?.seconds === "number") {
    const value = ts as FirestoreTimestamp;
    const nanos = typeof value.nanoseconds === "number" ? value.nanoseconds : 0;
    return value.seconds * 1000 + Math.floor(nanos / 1_000_000);
  }

  if (
    typeof (ts as FirestoreTimestampLegacy | undefined)?._seconds === "number"
  ) {
    const value = ts as FirestoreTimestampLegacy;
    const nanos =
      typeof value._nanoseconds === "number" ? value._nanoseconds : 0;
    return value._seconds * 1000 + Math.floor(nanos / 1_000_000);
  }

  if (
    typeof (ts as { toDate?: () => Date } | undefined)?.toDate === "function"
  ) {
    return (ts as { toDate: () => Date }).toDate().getTime();
  }

  return null;
};

/**
 * Derive an entity's creation/receipt timestamp (epoch ms) from an
 * action timestamp. This is the single source of truth for "when was
 * this created" — never parse a formatted `creationDate` string.
 *
 * Fails loudly: a missing/unresolvable timestamp is a programming error
 * (every replayed action carries one), not a recoverable fallback.
 */
export const deriveCreationTimestampMs = (
  ts: FirestoreTimestampLike,
): number => {
  const ms = toTimestampMs(ts);
  if (ms === null || !(ms > 0)) {
    throw new Error(
      `deriveCreationTimestampMs: timestamp not set (got ${JSON.stringify(ts)})`,
    );
  }
  return ms;
};

export const toFirestoreTimestamp = (
  ts: FirestoreTimestampLike,
): FirestoreTimestamp | null => {
  if (typeof (ts as FirestoreTimestamp | undefined)?.seconds === "number") {
    const value = ts as FirestoreTimestamp;
    return {
      seconds: value.seconds,
      nanoseconds:
        typeof value.nanoseconds === "number" ? value.nanoseconds : 0,
    };
  }

  if (
    typeof (ts as FirestoreTimestampLegacy | undefined)?._seconds === "number"
  ) {
    const value = ts as FirestoreTimestampLegacy;
    return {
      seconds: value._seconds,
      nanoseconds:
        typeof value._nanoseconds === "number" ? value._nanoseconds : 0,
    };
  }

  const ms = toTimestampMs(ts);
  if (ms === null) return null;
  return msToFirestoreTimestamp(ms);
};

export const isTimestampedAction = (
  action: unknown,
): action is TimestampedAction => {
  if (!action || typeof action !== "object") return false;
  const candidate = action as Partial<TimestampedAction>;
  return (
    typeof candidate._timestamp === "number" &&
    typeof candidate.timestamp?.seconds === "number" &&
    typeof candidate.timestamp?.nanoseconds === "number"
  );
};

export const normalizeTimestampedAction = <T extends Record<string, unknown>>(
  action: T,
): T & TimestampedAction => {
  const candidateTimestamp =
    action.timestamp ??
    action.createdAt ??
    action.createdAtMs ??
    action._timestamp;
  const normalizedTimestamp = toFirestoreTimestamp(
    candidateTimestamp as FirestoreTimestampLike,
  ) ?? {
    seconds: 0,
    nanoseconds: 0,
  };
  const normalizedMs =
    toTimestampMs(normalizedTimestamp) ??
    (typeof action._timestamp === "number" ? action._timestamp : 0);

  return {
    ...action,
    timestamp: normalizedTimestamp,
    _timestamp: normalizedMs,
  };
};

export const withInheritedTimestamp = <T extends Record<string, unknown>>(
  action: T,
  source: TimestampedAction,
): T & TimestampedAction => ({
  ...action,
  id: source.id ?? (action.id as string | undefined),
  timestamp: source.timestamp,
  _timestamp: source._timestamp,
});
