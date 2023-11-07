<script lang="ts">
  import Signin from "$lib/Signin.svelte";
  import type { User } from "$lib/auth";

  import { auth, googleAuthProvider } from "$lib/firebase";

  let me: User = { signedIn: false };
  function user(e: CustomEvent) {
    me = e.detail;
  }
</script>

{#if me.signedIn}
  <slot />
{:else}
  <Signin {auth} {googleAuthProvider} on:user_changed={user} />
{/if}
