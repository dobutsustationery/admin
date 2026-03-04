# Design: Long-Lived Google Authentication (Firebase Sync Methodology)

## 1. Context and Goal
Dobutsu Admin currently uses frontend-only OAuth2 Implicit Flow (`response_type=token`). This fails in modern browsers because hidden-iframe refresh depends on third-party cookies, and access tokens expire quickly.

We will move to Authorization Code Flow with PKCE and shift refresh-token handling to backend-only infrastructure. We keep Firebase Sync traceability, but `sync` events are status-only and never carry bearer tokens.

## 2. Data Model

### 2.1 Request Collection: `request_google_auth`
Client creates request documents that ask backend to perform auth work.
- `requestId`: Unique operation ID.
- `type`: `"exchange"` or `"refresh"`.
- `code`: Present only for `"exchange"`.
- `codeVerifier`: Present only for `"exchange"` (PKCE verifier).
- `createdAt`: Server timestamp.
- `creator`: Authenticated UID.

### 2.2 Sync Collection: `sync`
Append-only operational log for status and observability.
- `eventType`: `"google/auth_requested"`, `"google/auth_started"`, `"google/auth_completed"`, `"google/auth_failed"`.
- `requestId`: Correlates to request.
- `payload`:
  - `auth_completed`: metadata only, such as `tokenHandle`, `expiresIn`, `completedAt`.
  - `auth_failed`: `errorCode`, `message`.

`sync` MUST NOT include `access_token` or `refresh_token`.

### 2.3 Token Response Store (Backend-only write)
Ephemeral per-request auth response object, readable only by request owner.
- Example path: `google_auth_results/{uid}/requests/{requestId}`
- Fields: `tokenHandle`, optionally encrypted/short-lived `accessToken`, `expiresIn`, `createdAt`
- TTL cleanup required (for example, <= 5 minutes)

Preferred variant: `sync` completion with `tokenHandle`, then frontend redeems via callable HTTPS endpoint (`redeemGoogleAccessToken`). This keeps token delivery off public event streams.

## 3. Frontend Updates (`google-auth-unified.ts`)

### 3.1 Initiating OAuth
- Use `response_type=code`.
- Use PKCE (`code_challenge_method=S256`, generated `code_verifier`).
- Use `access_type=offline`.
- Use `prompt=consent` only when explicitly needed to (re)obtain refresh token.
- Remove hidden iframe refresh logic.

### 3.2 Callback Handling
- Parse `code` from query parameters.
- Create `request_google_auth/{requestId}` with `type=exchange`, `code`, `codeVerifier`.
- Listen for matching `sync` completion/failure events.
- On completion, redeem token through secure backend channel (callable/HTTPS or private per-user result document).
- Store access token in unified frontend storage.

### 3.3 Silent Refresh
- Create `request_google_auth/{requestId}` with `type=refresh`.
- Listen for `sync` completion/failure.
- On completion, redeem token via secure backend channel.

## 4. API Wrapper Behavior on 401
1. Catch 401 in Drive/Photos wrappers.
2. Call `await refreshTokensSilently()`.
3. If refresh succeeds, retry original request once.
4. If refresh fails, clear local token and require re-auth.

## 5. Backend Requirements (Cloud Functions)

### 5.1 Auth Processor Trigger
Trigger on new `request_google_auth` documents only.
- Validate requester identity and ownership.
- Write `google/auth_started` and terminal status events to `sync`.
- Exchange:
  - Call Google token endpoint with `code` + PKCE `code_verifier`.
  - Persist `refresh_token` in backend-only secret store (`user_secrets/{uid}` or Secret Manager mapping).
- Refresh:
  - Load stored refresh token.
  - Call Google refresh endpoint for new access token.
- Completion:
  - Do not write access token to `sync`.
  - Write ephemeral token result and/or redemption handle bound to UID + requestId.

### 5.2 Security Rules and IAM
- Clients can create only their own `request_google_auth` docs.
- Clients cannot write `sync` auth status events.
- Clients can read only their own token-result resource (if document-based delivery is used).
- Backend service account has exclusive write access to `sync` auth completion/failure and token-result resources.

## 6. Non-Negotiable Security Constraints
- `refresh_token` never leaves backend-controlled storage.
- `access_token` is never published in `sync`.
- All auth transitions remain visible in `sync` for observability.
- Access-token delivery to frontend must be user-scoped, short-lived, and one-request-at-a-time (requestId bound).
