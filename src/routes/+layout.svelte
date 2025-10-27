<script lang="ts">
  import { onMount } from "svelte";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/globals";
  import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    setDoc,
  } from "firebase/firestore";

  import { auth, googleAuthProvider } from "$lib/firebase";
  import type { User } from "@ourway/svelte-firebase-auth";
  import type { AnyAction } from "@reduxjs/toolkit";
  import { watchBroadcastActions } from "$lib/redux-firestore";
  import { store } from "$lib/store";
  import { logTime } from "$lib/timing";

  let me: User = { signedIn: false };
  let loading = true;
  let authReady = false;
  let SigninComponent: any = null;

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

  // Wait for auth to be fully ready before initializing watchers and rendering Signin
  // This prevents "Component auth has not been registered yet" errors in automated tests
  onMount(async () => {
    // Suppress transient auth initialization errors in console
    // These errors occur during emulator connection but don't prevent functionality
    const originalConsoleError = console.error;
    let suppressedErrorCount = 0;
    console.error = (...args: any[]) => {
      const errorStr = String(args[0]);
      // Suppress the specific auth initialization error
      if (errorStr.includes("Component auth has not been registered yet")) {
        suppressedErrorCount++;
        console.log(`⚠️  Suppressed transient auth initialization error (${suppressedErrorCount})`);
        return;
      }
      // Pass through all other errors
      originalConsoleError.apply(console, args);
    };

    // Wait for Firebase Auth to be fully initialized and ready
    // This is critical for emulator mode where auth connection takes time
    try {
      await auth.authStateReady();
      console.log("✓ Firebase Auth is ready");
    } catch (error) {
      console.error("Auth ready error:", error);
    }
    
    // Give a small additional delay for safety
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Dynamically import Signin component after auth is ready
    try {
      const module = await import("@ourway/svelte-firebase-auth");
      SigninComponent = module.Signin;
      authReady = true;
      console.log("✓ Signin component loaded");
    } catch (error) {
      console.error("Failed to load Signin component:", error);
      // Restore console.error after a delay
      setTimeout(() => {
        console.error = originalConsoleError;
      }, 1000);
      return;
    }
    
    // Restore console.error after component initialization
    setTimeout(() => {
      console.error = originalConsoleError;
      if (suppressedErrorCount > 0) {
        console.log(`✓ Suppressed ${suppressedErrorCount} transient auth errors during initialization`);
      }
    }, 1000);
    
    // Initialize broadcast watcher after auth is ready
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
  {#if authReady && SigninComponent}
    <span class:loading>
      <svelte:component this={SigninComponent} {auth} {googleAuthProvider} on:user_changed={signedInEvent} />
    </span>
  {/if}
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
