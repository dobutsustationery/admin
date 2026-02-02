# Live Drive/Photos E2E Setup (Turnkey)

This guide gets you from **no live test environment** to a fully configured setup for:
- `npm run test:live:doctor`
- `npm run test:live:contracts`
- `npm run test:live:workflows`
- `npm run test:live:e2e`

The setup is mostly automated by one script:
- `npm run setup:live:e2e`

---

## 1) Prerequisites

Install:
- `gcloud` CLI (for project + API setup automation)
- `bun` and `npm` (repo scripts use both)
- Browser available locally (OAuth consent flow opens URLs)

Authenticate gcloud once:

```bash
gcloud auth login
```

Optional but recommended:

```bash
gcloud auth application-default login
```

---

## 2) One-Command Bootstrap (Recommended)

Run:

```bash
npm run setup:live:e2e
```

What this script does:
1. Optionally enables required Google APIs (if you provide a project ID).
2. Prompts for OAuth Client ID + Secret.
3. Runs two OAuth consent flows and captures refresh tokens:
   - Drive token (`drive.file`)
   - Photos token (`photospicker.mediaitems.readonly`, `drive.readonly`, `userinfo.email`, `photoslibrary.appendonly`)
4. Creates/finds Drive root folder (default: `DobutsuE2E`).
5. Creates Photos fixtures album (default: `DobutsuE2EFixtures`).
6. Writes `.env.live.local` with all required `E2E_*` variables.

After it finishes:

```bash
set -a && source .env.live.local && set +a
npm run test:live:doctor
```

If `doctor` passes, continue:

```bash
npm run fixtures:google:sync
npm run test:live:e2e
```

---

## 3) Minimal Manual Steps Still Required

Google OAuth client creation is still a console step.

Create (or reuse) a **Web OAuth Client** in Google Cloud Console:
- APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
- Authorized redirect URI must include:
  - `http://127.0.0.1:8787/oauth2callback`

If this is a new project, also configure OAuth consent screen (External/Internal as needed).

Once you have client ID/secret, rerun:

```bash
npm run setup:live:e2e
```

---

## 4) Fully Automated GCP API Enablement

If you want the bootstrap to enable APIs for a specific project automatically:

```bash
npm run setup:live:e2e -- --project-id=YOUR_PROJECT_ID
```

Or skip gcloud automation entirely:

```bash
npm run setup:live:e2e -- --skip-gcloud
```

APIs enabled by automation:
- `drive.googleapis.com`
- `photoslibrary.googleapis.com`
- `photospicker.googleapis.com`
- `picker.googleapis.com`

---

## 5) Environment Variables (Generated)

`setup:live:e2e` writes `.env.live.local` with:
- `E2E_GOOGLE_CLIENT_ID`
- `E2E_GOOGLE_CLIENT_SECRET`
- `E2E_GOOGLE_DRIVE_REFRESH_TOKEN`
- `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`
- `E2E_GOOGLE_DRIVE_FOLDER_ID`
- `E2E_GOOGLE_PHOTOS_ALBUM_ID`

Do not commit this file.

Recommended shell loading pattern:

```bash
set -a && source .env.live.local && set +a
```

---

## 6) Validation + Daily Workflow

Validate setup:

```bash
set -a && source .env.live.local && set +a
npm run test:live:doctor
```

Run suites:

```bash
npm run test:live:contracts
npm run test:live:workflows
npm run test:live:e2e
```

Cleanup stale sandboxes:

```bash
npm run fixtures:google:cleanup
```

---

## 7) CI Setup

Add these secrets to CI:
- `E2E_GOOGLE_CLIENT_ID`
- `E2E_GOOGLE_CLIENT_SECRET`
- `E2E_GOOGLE_DRIVE_REFRESH_TOKEN`
- `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`
- `E2E_GOOGLE_DRIVE_FOLDER_ID`
- `E2E_GOOGLE_PHOTOS_ALBUM_ID`

Then run:

```bash
npm run test:live:doctor
npm run test:live:e2e
```

---

## 8) Troubleshooting

### `test:live:doctor` fails on Photos
- Re-run bootstrap and re-consent Photos scopes.
- Ensure the Photos account used in consent is the same one intended for fixtures.

### OAuth redirect fails
- Confirm OAuth client includes: `http://127.0.0.1:8787/oauth2callback`.

### Live E2E opens but is not authenticated
- Ensure env is sourced before run (`source .env.live.local`).
- Re-run bootstrap to rotate refresh tokens.

### Sandbox cleanup warning for Photos albums
- Drive folders are cleaned automatically.
- Photos albums may require periodic manual cleanup depending on API constraints/account policy.

