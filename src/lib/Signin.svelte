<script lang="ts">
import {
  type Auth,
  type AuthProvider,
  type User as FirebaseUser,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { createEventDispatcher } from "svelte";

export interface User {
  signedIn: boolean;
  uid?: string;
  email?: string;
  name?: string;
  photo?: string;
  last?: number;
}

let me: User = { signedIn: false };
export let auth: Auth;
export let googleAuthProvider: AuthProvider;

const dispatchEvent = createEventDispatcher();

onAuthStateChanged(auth, async (user: FirebaseUser | null) => {
  if (user && user.email) {
    const uid = user.uid;
    const name = user.displayName || "Unknown Name";
    const email = user.email;
    const photo = user.photoURL || "";
    const last = new Date().getTime();
    me = { signedIn: true, uid, email, name, photo, last };
  } else {
    me = { signedIn: false };
  }
  dispatchEvent("user_changed", me);
});

function login() {
  signInWithPopup(auth, googleAuthProvider)
    .then((result) => {
      dispatchEvent("sign_in", result);
    })
    .catch((message) => {
      dispatchEvent("error", message);
    });
}

function logout() {
  signOut(auth)
    .then(() => {
      dispatchEvent("sign_out", null);
    })
    .catch((message) => {
      dispatchEvent("error", message);
    });
}
</script>

{#if me.signedIn !== true}
  <button on:click={login}>Sign In</button>
{:else}
  <button on:click={logout}>Sign Out</button>
{/if}
