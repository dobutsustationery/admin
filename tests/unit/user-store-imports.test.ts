import { describe, expect, it } from "vitest";

// Regression: there used to be two separate Svelte writables both named
// `user` -- one in src/lib/user-store.ts (populated by Firebase Auth's
// onAuthStateChanged via +layout.svelte) and one in src/lib/globals.ts
// (initialized as writable<User>() with no value and never populated).
// Several pages and components imported `user` from globals and tried to
// read `$user.uid`, which crashed because $user was undefined.
//
// The fix re-exports globals.user from user-store so every caller sees
// the same populated store.  Lock that in: both modules must refer to the
// exact same store instance.

import { user as canonicalUser } from "../../src/lib/user-store";
import { user as legacyUser } from "../../src/lib/globals";

describe("user store singleton", () => {
  it("$lib/globals re-exports the canonical $lib/user-store", () => {
    expect(legacyUser).toBe(canonicalUser);
  });

  it("initial value is {signedIn: false} (never undefined)", () => {
    let captured: any;
    const unsub = canonicalUser.subscribe((v) => {
      captured = v;
    });
    unsub();
    expect(captured).toBeDefined();
    expect(captured.signedIn).toBe(false);
  });
});
