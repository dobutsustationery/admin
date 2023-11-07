<script lang="ts">
  import Signin from "$lib/Signin.svelte";
  import { doc, setDoc } from "firebase/firestore";
  import type { User } from "$lib/auth";
  import { firestore } from "$lib/firebase"

  import { auth, googleAuthProvider } from "$lib/firebase";

  let me: User = { signedIn: false };
  function user(e: CustomEvent) {
    me = e.detail;
    if (me.signedIn) {
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
</script>

{#if me.signedIn}
  <slot />
{:else}
  <Signin {auth} {googleAuthProvider} on:user_changed={user} />
{/if}
