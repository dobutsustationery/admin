<script lang="ts">
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/globals";
  import { doc, setDoc } from "firebase/firestore";

  import { auth, googleAuthProvider } from "$lib/firebase";
  import { Signin, type User } from "@ourway/svelte-firebase-auth";
  import type { AnyAction } from "@reduxjs/toolkit";
  import { watchBroadcastActions } from "$lib/redux-firestore";
  import { store } from "$lib/store";

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
  watchBroadcastActions(firestore, (changes) => {
    changes.forEach((change) => {
      const action = change.doc.data() as AnyAction;
      const id = change.doc.id;
      if (executedActions[id] === undefined) {
        console.log(JSON.stringify(action));
        executedActions[id] = action;
        store.dispatch(action);
      }
      if (action.timestamp !== null) {
        confirmedActions[id] = action;
      }
    });
  });
</script>

{#if me.signedIn}
  <slot />
{:else}
  <p class:loading>Loading...</p>
  <span class:loading>
    <Signin {auth} {googleAuthProvider} on:user_changed={signedInEvent} />
  </span>
{/if}

<style>
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
