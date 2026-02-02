# Live E2E Testing Setup Guide

This guide describes how to set up the environment for running "Live" End-to-End tests that interact with real Google Drive and Google Photos APIs.

> **⚠️ Security Warning:** These tests use *real* Google Cloud credentials. Ensure `E2E_GOOGLE_CLIENT_SECRET` and refresh tokens are kept secure and never committed to the repository (except in encrypted secrets management).

## 1. Prerequisites

You need a Google Cloud Project with the following APIs enabled:
- **Google Drive API**
- **Google Photos Library API**
- **Google Picker API**

## 2. Environment Variables

Create a `.env` file (or update your CI secrets) with the following variables. These are used by the test runner (`scripts/google-fixtures` and `playwright.live.config.ts`).

| Variable | Description | How to Obtain |
|----------|-------------|---------------|
| `E2E_GOOGLE_CLIENT_ID` | OAuth2 Client ID | Google Cloud Console > APIs & Services > Credentials |
| `E2E_GOOGLE_CLIENT_SECRET` | OAuth2 Client Secret | Google Cloud Console > APIs & Services > Credentials |
| `E2E_GOOGLE_DRIVE_REFRESH_TOKEN` | Long-lived Refresh Token for Drive | Run `scripts/google-fixtures/get-refresh-token.ts` (see below) or use OAuth Playground with `drive.file` scope. |
| `E2E_GOOGLE_PHOTOS_REFRESH_TOKEN`| Long-lived Refresh Token for Photos | Run retrieval script or use OAuth Playground with `photospicker.mediaitems.readonly` scope. |
| `E2E_GOOGLE_DRIVE_FOLDER_ID` | ID of the Drive Root Folder for E2E | Create a folder named "DobutsuE2E" in your Drive. The ID is the last part of the URL. |
| `E2E_GOOGLE_PHOTOS_ALBUM_ID` | ID of the Photos Album for E2E | Use `scripts/google-fixtures/create-album.ts` (if available) or create manually and inspect API. |

## 3. Obtaining Refresh Tokens

To obtain the necessary refresh tokens, you can use the Google OAuth 2.0 Playground or a helper script (if implemented).

**Scopes Required:**
- **Drive Token:** `https://www.googleapis.com/auth/drive.file`
- **Photos Token:** `https://www.googleapis.com/auth/photospicker.mediaitems.readonly`, `https://www.googleapis.com/auth/drive.readonly` (for hybrid access)

**Steps via OAuth Playground:**
1. Go to [Google OAuth Playground](https://developers.google.com/oauthplayground/).
2. Click the Gear icon and check "Use your own OAuth credentials". Enter your Client ID and Client Secret.
3. Select the required scopes.
4. Click "Authorize APIs".
5. Exchange authorization code for tokens.
6. Copy the `refresh_token`.

## 4. Running the Tests

Once configured, verify your setup:

```bash
# 1. Check Health
npm run test:live:doctor

# 2. Sync Seed Data (Uploads test images to your Seed folder)
npm run fixtures:google:sync

# 3. Run Contract Tests
npm run test:live:contracts

# 4. Run Full Browser E2E
npm run test:live:e2e
```
