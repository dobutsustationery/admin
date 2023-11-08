<script lang="ts">
  import { doc, setDoc } from "firebase/firestore";
  import { firestore } from "$lib/firebase";

  import { auth, googleAuthProvider } from "$lib/firebase";
  import { Signin, type User } from "@ourway/svelte-firebase-auth";

  let me: User = { signedIn: false };
  let loading = true;
  function user(e: CustomEvent) {
    me = e.detail;
    loading = false;
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
  <p class:loading>Loading...</p>
  <span class:loading>
    <Signin {auth} {googleAuthProvider} on:user_changed={user} />
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
