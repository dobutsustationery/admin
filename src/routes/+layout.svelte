<script lang="ts">
import { firestore } from "$lib/firebase";
import { user } from "$lib/globals";
import { addDoc, collection, deleteDoc, doc, setDoc } from "firebase/firestore";

import { auth, googleAuthProvider } from "$lib/firebase";
import { watchBroadcastActions } from "$lib/redux-firestore";
import { store } from "$lib/store";
import { logTime } from "$lib/timing";
import Signin, { type User } from "$lib/Signin.svelte";
import type { AnyAction } from "@reduxjs/toolkit";

let me: User = { signedIn: false };
let loading = true;
function signedInEvent(e: CustomEvent) {
  me = e.detail;
  loading = false;
  if (me.signedIn) {
    $user = me;
    setDoc(doc(firestore, "users", me.email), {
      uid: me.uid,
      name: me.name,
      email: me.email,
      photo: me.photo,
      activity_timestamp: new Date().getTime(),
    }).catch((message) => {
      // TODO: Surface this error state in the UI.
      console.error(message);
    });
  }
}

const executedActions: { [k: string]: AnyAction } = {};
const confirmedActions: { [k: string]: AnyAction } = {};
let unsyncedActions = 0;
logTime("about to watchBroadcastActions");
watchBroadcastActions(firestore, (changes) => {
  logTime(`  watchBroadcastActions received ${changes.length} actions.`);
  changes.forEach((change) => {
    const action = change.doc.data() as AnyAction;
    const id = change.doc.id;
    if (executedActions[id] === undefined) {
      executedActions[id] = action;
      if (action.type === "retype_item") {
        const itemKey = action.payload.itemKey;
        const newItemKey = action.payload.janCode + action.payload.subtype;
        if (itemKey == newItemKey) {
          console.error("bad retype item detected: ", JSON.stringify(action));
          setDoc(doc(firestore, `jailed/${id}`), action)
            .then(() => {
              console.log(`jail complete for ${id}`);
            })
            .catch((err) => {
              console.error(`JAILED ERROR for ${id}: `, err);
            });
          deleteDoc(change.doc.ref)
            .then(() => {
              console.log(`deletion of jailed item complete for ${id}`);
            })
            .catch((err) => {
              console.error(`DELETE ERROR for ${id}: `, err);
            });
        }
      }
      store.dispatch(action);
    }
    if (action.timestamp !== null) {
      confirmedActions[id] = action;
    }
    unsyncedActions =
      Object.keys(executedActions).length -
      Object.keys(confirmedActions).length;
  });
});
/*
  const delayLimit = 100000000;
  for (let delay = 0; delay < delayLimit; ++delay) {
    if (delay % (delayLimit / 10) === 0) {
      logTime('twiddling our thumbs')
    }
  }
  */
</script>

{#if me.signedIn}
  {#if unsyncedActions}
    <div>{unsyncedActions}</div>
  {/if}
  <slot />
{:else}
  <p class:loading>Loading...</p>
  <span class:loading>
    <Signin {auth} {googleAuthProvider} on:user_changed={signedInEvent} />
  </span>
{/if}

<style>
  div {
    width: 1em;
    height: 1em;
    line-height: 1em;
    text-align: center;
    background-color: red;
    color: ivory;
    font-weight: bold;
    border-radius: 50%;
    padding: 0.5em;
    float: right;
  }
  p {
    display: none;
  }
  p.loading {
    display: block;
    animation: 1s ease 0s normal forwards 1 fadein;
  }

  @keyframes fadein {
    0% {
      opacity: 0;
    }
    66% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }

  @-webkit-keyframes fadein {
    0% {
      opacity: 0;
    }
    66% {
      opacity: 0;
    }
    100% {
      opacity: 1;
    }
  }

  span.loading {
    display: none;
  }
</style>
