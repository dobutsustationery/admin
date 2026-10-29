async function saveEtsyAuthorization(db, tokens, atMs) {
  if (!tokens.access_token || !tokens.refresh_token)
    throw Error("Missing Etsy authorization tokens");
  await db
    .collection("etsy_order_sync_state")
    .doc("default")
    .set(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        grantedScopes: String(tokens.scope || "")
          .split(/\s+/)
          .filter(Boolean),
        authorizedAtMs: atMs,
        tokensRefreshedAt: atMs,
      },
      { merge: true },
    );
  const grantedScopes = String(tokens.scope || "")
    .split(/\s+/)
    .filter(Boolean);
  await db
    .collection("etsy_listing_sync")
    .doc("state")
    .set(
      {
        grantedScopes,
        canWrite: grantedScopes.includes("listings_w"),
      },
      { merge: true },
    );
}
module.exports = { saveEtsyAuthorization };
