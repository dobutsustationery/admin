/**
 * Unified Google OAuth Service
 *
 * PKCE Authorization Code flow with backend token exchange/refresh via Firestore requests.
 */

import {
  GOOGLE_AUTH_COMPLETED_EVENT,
  GOOGLE_AUTH_FAILED_EVENT,
  GOOGLE_AUTH_REQUEST_COLLECTION,
  GOOGLE_AUTH_RESULTS_COLLECTION,
  SYNC_COLLECTION,
} from "$lib/sync-events";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
} from "firebase/firestore";

const GOOGLE_DRIVE_CLIENT_ID = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID;
const GOOGLE_PHOTOS_CLIENT_ID = import.meta.env.VITE_GOOGLE_PHOTOS_CLIENT_ID;

const CLIENT_ID = GOOGLE_PHOTOS_CLIENT_ID || GOOGLE_DRIVE_CLIENT_ID;

const DRIVE_SCOPES = (
  import.meta.env.VITE_GOOGLE_DRIVE_SCOPES ||
  "https://www.googleapis.com/auth/drive.file"
).split(",");
const PHOTOS_SCOPES = (
  import.meta.env.VITE_GOOGLE_PHOTOS_SCOPES ||
  "https://www.googleapis.com/auth/photospicker.mediaitems.readonly,https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/userinfo.email"
).split(",");

const ALL_SCOPES = Array.from(
  new Set([
    ...DRIVE_SCOPES,
    ...PHOTOS_SCOPES,
    "https://www.googleapis.com/auth/userinfo.email",
  ]),
);

const TOKEN_STORAGE_KEY = "google_photos_access_token";
const PKCE_STORAGE_KEY = "google_auth_pkce_state";

export interface GoogleAuthToken {
  access_token: string;
  expires_in: number;
  expires_at: number;
  scope: string;
  token_type: string;
  user_email?: string;
}

type PkcePendingState = {
  requestId: string;
  codeVerifier: string;
  returnUrl?: string;
  createdAtMs: number;
};

let cachedFirebaseClients: { auth: any; firestore: any } | null = null;

async function getFirebaseClients(): Promise<{ auth: any; firestore: any }> {
  if (cachedFirebaseClients) return cachedFirebaseClients;
  const mod = await import("$lib/firebase");
  cachedFirebaseClients = {
    auth: mod.auth,
    firestore: mod.firestore,
  };
  return cachedFirebaseClients;
}

function generateRequestId(prefix = "auth"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${random}`;
}

function getRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1)
    raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toBase64Url(new Uint8Array(hash));
}

function savePkceState(state: PkcePendingState): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(state));
}

function loadPkceState(): PkcePendingState | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PkcePendingState;
  } catch {
    return null;
  }
}

function clearPkceState(): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
}

function buildStateParam(requestId: string, returnUrl?: string): string {
  return `unified_auth|${requestId}|${encodeURIComponent(returnUrl || "")}`;
}

function parseStateParam(rawState: string): {
  requestId?: string;
  returnUrl?: string;
} {
  const [ns, requestId, encodedReturnUrl] = String(rawState || "").split("|");
  if (ns !== "unified_auth") return {};
  return {
    requestId: requestId || undefined,
    returnUrl: encodedReturnUrl
      ? decodeURIComponent(encodedReturnUrl)
      : undefined,
  };
}

async function waitForAuthenticatedUserUid(
  authInstance: any,
  timeoutMs = 15_000,
): Promise<string> {
  const immediateUid = authInstance?.currentUser?.uid;
  if (immediateUid) return immediateUid;

  const { onAuthStateChanged } = await import("firebase/auth");

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for Firebase authentication"));
    }, timeoutMs);

    const unsubscribe = onAuthStateChanged(
      authInstance,
      (user) => {
        if (!user?.uid) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(user.uid);
      },
      (error) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(error);
      },
    );
  });
}

function buildStoredToken(data: {
  accessToken: string;
  expiresIn: number;
  scope?: string;
  tokenType?: string;
}): GoogleAuthToken {
  const expiresIn = Number(data.expiresIn || 0);
  return {
    access_token: data.accessToken,
    expires_in: expiresIn,
    expires_at: Date.now() + expiresIn * 1000,
    scope: data.scope || ALL_SCOPES.join(" "),
    token_type: data.tokenType || "Bearer",
  };
}

async function waitForAuthTerminalEvent(
  firestoreDb: any,
  requestId: string,
  timeoutMs = 45_000,
): Promise<{ ok: boolean; payload?: Record<string, any>; eventType: string }> {
  return new Promise((resolve, reject) => {
    const q = query(
      collection(firestoreDb, SYNC_COLLECTION),
      where("requestId", "==", requestId),
    );

    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for auth sync completion"));
    }, timeoutMs);

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const events = snapshot.docs.map(
          (d) =>
            ({ id: d.id, ...(d.data() as Record<string, any>) }) as Record<
              string,
              any
            >,
        );
        const terminal = events
          .filter(
            (ev) =>
              ev.eventType === GOOGLE_AUTH_COMPLETED_EVENT ||
              ev.eventType === GOOGLE_AUTH_FAILED_EVENT,
          )
          .sort(
            (a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0),
          )[0];

        if (!terminal) return;

        clearTimeout(timeout);
        unsubscribe();

        if (terminal.eventType === GOOGLE_AUTH_COMPLETED_EVENT) {
          resolve({
            ok: true,
            payload: terminal.payload || {},
            eventType: terminal.eventType,
          });
        } else {
          resolve({
            ok: false,
            payload: terminal.payload || {},
            eventType: terminal.eventType,
          });
        }
      },
      (err) => {
        clearTimeout(timeout);
        unsubscribe();
        reject(err);
      },
    );
  });
}

async function waitForAuthResultDoc(
  uid: string,
  requestId: string,
): Promise<Record<string, any>> {
  const { firestore } = await getFirebaseClients();
  const ref = doc(
    firestore,
    GOOGLE_AUTH_RESULTS_COLLECTION,
    uid,
    "requests",
    requestId,
  );

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      const data = snap.data() as Record<string, any>;
      // Best-effort cleanup to keep auth artifacts short-lived.
      await deleteDoc(ref).catch(() => {});
      return data;
    }
    await new Promise((r) => window.setTimeout(r, 300));
  }

  throw new Error("Token result document not found");
}

async function requestBackendToken(params: {
  requestId: string;
  type: "exchange" | "refresh";
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
}): Promise<GoogleAuthToken | null> {
  const { auth, firestore } = await getFirebaseClients();
  const uid = await waitForAuthenticatedUserUid(auth);

  await setDoc(
    doc(firestore, GOOGLE_AUTH_REQUEST_COLLECTION, params.requestId),
    {
      requestId: params.requestId,
      type: params.type,
      code: params.code || null,
      codeVerifier: params.codeVerifier || null,
      redirectUri: params.redirectUri || null,
      creator: uid,
      createdAt: serverTimestamp(),
      createdAtMs: Date.now(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      expiresAtMs: Date.now() + 5 * 60 * 1000,
    },
  );

  const terminal = await waitForAuthTerminalEvent(firestore, params.requestId);
  if (!terminal.ok) return null;

  const resultDoc = await waitForAuthResultDoc(uid, params.requestId);
  if (!resultDoc?.accessToken || !resultDoc?.expiresIn) return null;

  const token = buildStoredToken({
    accessToken: String(resultDoc.accessToken),
    expiresIn: Number(resultDoc.expiresIn),
    scope: String(resultDoc.scope || ALL_SCOPES.join(" ")),
    tokenType: String(resultDoc.tokenType || "Bearer"),
  });

  storeToken(token);
  return token;
}

export function getStoredToken(): GoogleAuthToken | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (!parsed || typeof parsed.expires_at !== "number") return null;

    if (Date.now() > parsed.expires_at) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    return parsed as GoogleAuthToken;
  } catch {
    return null;
  }
}

export function getExpiryInfo() {
  const token = getStoredToken();
  if (!token) return null;
  const now = Date.now();
  const expiresInSeconds = Math.max(
    0,
    Math.floor((token.expires_at - now) / 1000),
  );
  return {
    expired: expiresInSeconds <= 0,
    expiresInSeconds,
    expiresAt: token.expires_at,
  };
}

export function isAuthenticated(): boolean {
  const expiry = getExpiryInfo();
  return !!expiry && !expiry.expired;
}

export function storeToken(token: GoogleAuthToken): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(token));
}

export async function handleOAuthCallback(): Promise<{
  token: GoogleAuthToken;
  returnUrl?: string;
} | null> {
  if (typeof window === "undefined") return null;

  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const authError = params.get("error");
  const state = params.get("state") || "";

  if (!code && !authError) return null;

  try {
    if (authError) {
      throw new Error(`OAuth error: ${authError}`);
    }

    const parsedState = parseStateParam(state);
    const pkceState = loadPkceState();
    if (!pkceState?.requestId || !pkceState?.codeVerifier) {
      throw new Error("Missing PKCE state for OAuth callback");
    }

    if (
      !parsedState.requestId ||
      parsedState.requestId !== pkceState.requestId
    ) {
      throw new Error("OAuth state mismatch");
    }

    const token = await requestBackendToken({
      requestId: pkceState.requestId,
      type: "exchange",
      code: String(code || ""),
      codeVerifier: pkceState.codeVerifier,
      redirectUri: `${window.location.origin}/photos`,
    });

    if (!token) return null;

    clearPkceState();
    window.history.replaceState({}, document.title, window.location.pathname);

    return {
      token,
      returnUrl: parsedState.returnUrl || pkceState.returnUrl,
    };
  } catch (e) {
    console.error("[Auth] Error handling OAuth callback:", e);
    return null;
  }
}

export async function initiateOAuthFlow(
  allowSwitchAccount = false,
  returnUrl?: string,
  forceConsent = false,
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!CLIENT_ID) throw new Error("Google OAuth client ID is not configured");

  const currentPath = window.location.pathname + window.location.search;
  const effectiveReturnUrl = returnUrl || currentPath;
  const requestId = generateRequestId("google_auth");
  const redirectUri = `${window.location.origin}/photos`;

  const verifierBytes = getRandomBytes(64);
  const codeVerifier = toBase64Url(verifierBytes);
  const codeChallenge = await sha256Base64Url(codeVerifier);

  savePkceState({
    requestId,
    codeVerifier,
    returnUrl: effectiveReturnUrl,
    createdAtMs: Date.now(),
  });

  const oauthState = buildStateParam(requestId, effectiveReturnUrl);

  const qs = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    include_granted_scopes: "true",
    scope: ALL_SCOPES.join(" "),
    state: oauthState,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  if (allowSwitchAccount) {
    qs.set("prompt", "select_account");
  }
  if (forceConsent) {
    qs.set("prompt", allowSwitchAccount ? "consent select_account" : "consent");
  }

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${qs.toString()}`;
}

export async function refreshTokensSilently(): Promise<boolean> {
  try {
    const requestId = generateRequestId("google_refresh");
    const token = await requestBackendToken({
      requestId,
      type: "refresh",
    });
    return !!token;
  } catch (e) {
    console.error("[Auth] Refresh failed:", e);
    return false;
  }
}

export function clearToken(): void {
  if (typeof localStorage !== "undefined") {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem("google_drive_access_token");
  }
}
