import { writable } from "svelte/store";
import {
  doc,
  getDocFromServer,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import { firestore } from "./firebase";
interface DraftEvent {
  type: string;
  payload: {
    sellerId: string;
    owner: string;
    revision: number;
    token: string;
    [key: string]: unknown;
  };
  acknowledged?: boolean;
}
// Synchronously save raw input before networking. Retain it until BOTH server
// acknowledgement and reducer replay: Firestore can replay local writes first.
export function createDraftJournal(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  send: (event: DraftEvent) => Promise<void>,
) {
  let events: DraftEvent[] = JSON.parse(storage.getItem(key) || "[]");
  let running = false,
    seenRevision = -1,
    seenToken = "";
  const state = writable({ events, error: "" });
  function persist(next: DraftEvent[]) {
    storage.setItem(key, JSON.stringify(next));
    events = next;
  }
  function prune() {
    const next = events.filter(
      (e) =>
        !e.acknowledged ||
        e.payload.revision > seenRevision ||
        (e.payload.revision === seenRevision && e.payload.token > seenToken),
    );
    if (next.length !== events.length) persist(next);
  }
  async function flush() {
    if (running) return;
    running = true;
    try {
      while (true) {
        const event = events.find((e) => !e.acknowledged);
        if (!event) break;
        await send({ type: event.type, payload: event.payload });
        persist(
          events.map((e) =>
            e.payload.token === event.payload.token
              ? { ...e, acknowledged: true }
              : e,
          ),
        );
        prune();
        state.set({ events, error: "" });
      }
    } catch (e: any) {
      state.set({ events, error: e.message || "Draft sync failed" });
    } finally {
      running = false;
    }
  }
  function append(event: DraftEvent) {
    persist([...events, event]);
    state.set({ events, error: "" });
    void flush();
  }
  function observed(revision: number, token: string) {
    seenRevision = revision;
    seenToken = token;
    const old = events;
    try {
      prune();
      if (old !== events) state.set({ events, error: "" });
    } catch (e: any) {
      state.set({ events, error: e.message });
    }
  }
  return { subscribe: state.subscribe, append, flush, observed };
}
const journals = new Map<string, ReturnType<typeof createDraftJournal>>();
export function amazonDraftJournal(owner: string, seller: string) {
  const key = `amazon-preparation-draft:${firestore.app.options.projectId}:${owner}:${seller}`;
  if (!journals.has(key)) {
    const journal = createDraftJournal(localStorage, key, async (event) => {
      const ref = doc(
        firestore,
        "broadcast",
        `amazon-draft-${event.payload.token}`,
      );
      if ((await getDocFromServer(ref)).exists()) return;
      await setDoc(ref, {
        ...event,
        creator: owner,
        timestamp: serverTimestamp(),
      });
    });
    journals.set(key, journal);
    window.addEventListener("online", () => void journal.flush());
  }
  return journals.get(key)!;
}
