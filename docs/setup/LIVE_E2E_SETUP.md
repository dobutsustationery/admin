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

From a fresh machine, run:

```bash
direnv allow
```

That Nix shell provides all required CLI tools for this setup, including:
- `gcloud` (via `google-cloud-sdk`)
- `bun` / `npm`

You only need a browser available locally for the `gcloud` OAuth login flow.

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
1. Detects existing `dobutsu-e2e*` projects and prompts you to reuse/delete to avoid project sprawl; then ensures exactly one active target project.
2. Enables required APIs.
3. Uses `gcloud auth application-default login` for project automation.
4. Uses your app OAuth Client ID/Secret (from JSON/env/prompt) and runs local OAuth to mint Drive/Photos refresh tokens.
5. Creates/finds Drive root folder (default: `DobutsuE2E`).
6. Creates Photos fixtures album (default: `DobutsuE2EFixtures`).
7. Writes `.env.live.local` with all required `E2E_*` variables.

Project selection behavior (when `--project-id` is not provided):
- 0 matching projects: creates one.
- 1 matching project: prompts to reuse or delete+recreate.
- 2+ matching projects: prompts to delete all and create one fresh project.

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

`fixtures:google:sync` now uploads missing fixtures from `e2e/fixtures/photo-data/` based on `e2e/fixtures/google-media-manifest.json` (Drive `Seed` folder + configured Photos album).

---

## 3) Project + Firebase Options

One required manual setup remains: create an OAuth **Web application** client in Google Auth Platform and add redirect URI:

```
http://127.0.0.1:8787/oauth2callback
```

You can then either:
- set `E2E_GOOGLE_CLIENT_ID` / `E2E_GOOGLE_CLIENT_SECRET` before bootstrap, or
- paste the path to downloaded Google OAuth JSON when prompted, or
- paste them when prompted by `setup:live:e2e`.

The script reads:
- `web.client_id`
- `web.client_secret`
- `web.project_id`
- `web.redirect_uris`

and validates that:
- the JSON belongs to the same project being bootstrapped
- redirect URI includes `http://127.0.0.1:8787/oauth2callback`

Important: that OAuth client must belong to the same GCP project being bootstrapped.  
If you provide credentials from another project, Photos/Drive scope flows can fail even when APIs are enabled on the new project.

Tip: the bootstrap script automatically reads `.env.emulator` and `.env.local` for:
- `E2E_GOOGLE_CLIENT_ID`
- `E2E_GOOGLE_CLIENT_SECRET`
- `VITE_GOOGLE_DRIVE_CLIENT_ID`
- `VITE_GOOGLE_PHOTOS_CLIENT_ID`

It also reads `.env.live.local` on reruns, so once bootstrap succeeds you should not need to re-paste client credentials.

If only client ID is present, the script gives explicit console directions for obtaining the matching client secret.
It also prints direct project-scoped console URLs (OAuth clients + API pages) and validates client/project number alignment.

Pass an explicit project id:

```bash
npm run setup:live:e2e -- --project-id=dobutsu-live-e2e
```

Also initialize Firebase on that project (optional):

```bash
npm run setup:live:e2e -- --project-id=dobutsu-live-e2e --add-firebase
```

---

## 4) Useful Flags

Use a specific project name while creating the project:

```bash
npm run setup:live:e2e -- --project-id=YOUR_PROJECT_ID --project-name="Dobutsu Live E2E"
```

Skip project creation:

```bash
npm run setup:live:e2e -- --project-id=YOUR_PROJECT_ID --no-create-project
```

Skip API enablement:

```bash
npm run setup:live:e2e -- --project-id=YOUR_PROJECT_ID --skip-api-enablement
```

Skip ADC login (only if you already ran it before):

```bash
npm run setup:live:e2e -- --project-id=YOUR_PROJECT_ID --skip-adc-login
```

When prompted, you can paste a local path such as:

```bash
~/Downloads/client_secret_XXXX.json
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
- `E2E_GOOGLE_PROJECT_ID`

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
- If you see `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, your existing refresh token predates scope updates; run `npm run setup:live:e2e` again to rotate `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`.

### Bootstrap cannot create project
- Ensure your gcloud account has permission to create projects in your org.
- Re-run with an existing project and `--no-create-project`.

### ADC login complains cloud-platform scope is required
- Use the latest bootstrap script; it now includes `https://www.googleapis.com/auth/cloud-platform` automatically when running ADC login.

### Live E2E opens but is not authenticated
- Ensure env is sourced before run (`source .env.live.local`).
- Re-run bootstrap to rotate refresh tokens.

### Sandbox cleanup warning for Photos albums
- Drive folders are cleaned automatically.
- Photos albums may require periodic manual cleanup depending on API constraints/account policy.
