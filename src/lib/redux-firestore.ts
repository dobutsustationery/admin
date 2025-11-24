import type { AnyAction } from "@reduxjs/toolkit";
import {
  type DocumentChange,
  type DocumentData,
  type Firestore,
  type FirestoreError,
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from "firebase/firestore";

export async function broadcast(fs: Firestore, uid: string, action: AnyAction) {
  const broadcasts = collection(fs, "broadcast");
  return addDoc(broadcasts, {
    ...action,
    timestamp: serverTimestamp(),
    creator: uid,
  });
}

export type WatchCallback = (changes: DocumentChange<DocumentData>[]) => void;
export type ErrorCallback = (e: FirestoreError) => void;

export function watchBroadcastActions(
  fs: Firestore,
  callback: WatchCallback,
  errorCallback?: ErrorCallback,
) {
  const broadcasts = collection(fs, "broadcast");
  return onSnapshot(
    query(broadcasts, orderBy("timestamp")),
    (querySnapshot) => {
      callback(querySnapshot.docChanges());
    },
    (error) => {
      console.log("broadcasts query failing: ");
      console.error(error);
      if (errorCallback) {
        errorCallback(error);
      }
    },
  );
}
