# Deployment Guide

This guide describes how to deploy the Antigravity Admin application to production using Firebase Hosting.

## Architecture Overview

- **Application Type**: Client-Side Single Page Application (SPA) built with SvelteKit (Static Adapter).
- **Hosting**: Firebase Hosting.
- **Authentication**: Firebase Auth (User Management) + OAuth 2.0 Implicit Flow (Google Drive Integration).
- **Backend**: None (purely client-side).

## Prerequisites

- Node.js (v18+)
- npm
- Firebase CLI (`npm install -g firebase-tools`)
- Access to the `dobutsu-stationery-6b227` Firebase project.

## Environment Variables

The application uses Vite environment variables for configuration. These are **build-time** variables, meaning they are baked into the JavaScript bundle when you run `npm run build`.

**Important:** Do not commit `.env.production` file containing real keys if possible. Instead, use your CI/CD system's secret management or build arguments.

### Required Production Variables

Create a `.env.production` file (or set these in your CI pipeline):

```env
# Firebase Configuration (Production)
VITE_FIREBASE_ENV=production
VITE_FIREBASE_API_KEY=AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q
VITE_FIREBASE_AUTH_DOMAIN=dobutsu-stationery-6b227.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=dobutsu-stationery-6b227
VITE_FIREBASE_STORAGE_BUCKET=dobutsu-stationery-6b227.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=346660531589
VITE_FIREBASE_APP_ID=1:346660531589:web:d04e079432b6434a7b28ec
VITE_FIREBASE_MEASUREMENT_ID=G-QM2RSC0RC7

# Google Drive Integration (Production)
# You MUST create these in Google Cloud Console
VITE_GOOGLE_DRIVE_CLIENT_ID=your-real-production-client-id.apps.googleusercontent.com
VITE_GOOGLE_DRIVE_FOLDER_ID=your-real-production-folder-id
VITE_GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file
```

## Google Cloud Console Configuration

For the Drive integration to work in production, you must configure the OAuth Client ID in the Google Cloud Console:

1.  Go to [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials).
2.  Edit the OAuth 2.0 Client ID used for production.
3.  **Authorized JavaScript Origins**: Add your production domain(s):
    - `https://admin.dobutsustationery.com`
    - `https://dobutsu-stationery-6b227.web.app` (Firebase default)
4.  **Authorized Redirect URIs**: Add the CSV page URL:
    - `https://admin.dobutsustationery.com/csv`
    - `https://dobutsu-stationery-6b227.web.app/csv`

## Build and Deploy

1.  **Install Dependencies**:
    ```bash
    npm ci
    ```

2.  **Build and Deploy**:
    The project includes convenience scripts to handle environment variable injection and deployment.
    ```bash
    # Standard Production Deployment
    # Builds with .env.production variables and deploys to Firebase
    npm run deploy
    ```
    Alternatively, you can be explicit:
    ```bash
    npm run deploy:production
    ```

## Verification

After deployment:
1.  Visit `https://your-production-url.com/csv`.
2.  Open the Developer Console (F12).
3.  Click "Connect to Google Drive".
4.  Ensure the Google OAuth pop-up appears and shows the correct application name.
5.  If you see `Error 400: origin_mismatch`, check the "Authorized JavaScript Origins" in Google Cloud Console.
