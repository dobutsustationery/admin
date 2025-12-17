<script context="module" lang="ts">
  export interface User {
    signedIn: boolean;
    uid?: string;
    email?: string;
    name?: string;
    photo?: string;
    last?: number;
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import {
    onAuthStateChanged,
    signOut,
    signInWithPopup,
    type Auth,
    type AuthProvider,
    type User as FirebaseUser,
  } from "firebase/auth";

  let me: User = { signedIn: false };
  export let auth: Auth;
  export let googleAuthProvider: AuthProvider;

  const dispatchEvent = createEventDispatcher();

  import { REQUIRED_SCOPES } from "$lib/firebase";

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

  import { GoogleAuthProvider } from "firebase/auth";

  function login() {
    signInWithPopup(auth, googleAuthProvider)
      .then((result) => {
        // Extract OAuth Access Token for Google APIs
        const credential = GoogleAuthProvider.credentialFromResult(result);
        if (credential && credential.accessToken) {
          // Save token for Drive/Photos API usage
          const tokenData = {
            access_token: credential.accessToken,
            expires_in: 3600, // Required by google-photos.ts validation
            expires_at: Date.now() + 3600 * 1000, 
            // Use granted scopes from credential or fallback to our required scopes joined by space
            scope: (credential as any).scope || REQUIRED_SCOPES.join(" ")
          };
          localStorage.setItem("google_drive_access_token", JSON.stringify(tokenData));
          localStorage.setItem("google_photos_access_token", JSON.stringify(tokenData));
        }
        
        dispatchEvent("sign_in", result);
      })
      .catch((message) => {
        console.error("Login failed:", message);
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
