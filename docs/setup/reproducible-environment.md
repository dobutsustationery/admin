# Environment Configuration Guide

This guide explains how to configure and switch between different Firebase environments in the Dobutsu Admin application.

## Overview

The application supports three distinct environments:

1. **Local** - Firebase emulators running on your machine (offline development)
2. **Staging** - Staging Firebase project in the cloud (testing)
3. **Production** - Production Firebase project in the cloud (live data)

## Quick Start

### Method 1: Direct Mode Selection (Recommended)

The easiest way is to use the environment-specific npm scripts:

```bash
# Local development with emulators
npm run dev:local

# Staging environment
npm run dev:staging

# Production environment
npm run dev:production
```

### Method 2: Environment Switcher

Set a default environment that persists between sessions:

```bash
# Set default to local
npm run env:local

# Set default to staging
npm run env:staging

# Set default to production
npm run env:production

# Now run dev normally
npm run dev
```

## Environment Details

### Local Environment (Emulators)

**Best for:** Development, testing without affecting live data, offline work

**Setup:**

1. No configuration needed - `.env.emulator` is pre-configured (loaded automatically when using `npm run dev:local`)
2. Start the Firebase emulators:
   ```bash
   npm run emulators
   ```
3. In a separate terminal, start the dev server:
   ```bash
   npm run dev:local
   ```

**Access:**
- Application: http://localhost:5173
- Emulator UI: http://localhost:4000

**Features:**
- No internet connection required (after initial setup)
- Data persists only during emulator session
- Safe to experiment without affecting production
- Can export/import data for testing scenarios

**Emulator Data Management:**

```bash
# Export current emulator data
npm run emulators:export

# Import previously exported data
npm run emulators:import
```

### Staging Environment

**Best for:** Testing with real Firebase, QA, pre-production validation

**Setup:**

1. Create a Firebase project for staging (if you haven't already)
2. Get your Firebase web app configuration from the Firebase Console
3. Convert it to `.env.staging` format using the Firebase config converter:
   ```bash
   npm run firebase:convert:staging
   ```
   Then paste your Firebase config when prompted, or use:
   ```bash
   node scripts/firebase-config-to-env.js --input firebase-config.json --env staging --output .env.staging
   ```
   
   Alternatively, manually edit `.env.staging` with your staging Firebase credentials:
   ```
   VITE_FIREBASE_ENV=staging
   VITE_FIREBASE_STAGING_API_KEY=your-staging-api-key
   VITE_FIREBASE_STAGING_AUTH_DOMAIN=your-staging-project.firebaseapp.com
   VITE_FIREBASE_STAGING_PROJECT_ID=your-staging-project
   VITE_FIREBASE_STAGING_STORAGE_BUCKET=your-staging-project.appspot.com
   VITE_FIREBASE_STAGING_MESSAGING_SENDER_ID=your-staging-sender-id
   VITE_FIREBASE_STAGING_APP_ID=your-staging-app-id
   VITE_FIREBASE_STAGING_MEASUREMENT_ID=your-staging-measurement-id
   ```
4. Run:
   ```bash
   npm run dev:staging
   ```

**Features:**
- Real Firebase cloud environment
- Isolated from production data
- Can test Firebase features not available in emulators
- Requires internet connection

### Production Environment

**Best for:** Live operations, production deployments

**Setup:**

Pre-configured with production credentials in `.env.production`. To use:

```bash
npm run dev:production
```

**⚠️ Important:**
- This connects to the live production database
- Changes affect real data and real users
- Use with caution during development
- Consider using local or staging for most development work

## Configuration Files

### Firebase Config Converter

For easy setup of staging or production environments, use the Firebase config converter utility:

```bash
# Convert Firebase config to .env.staging
npm run firebase:convert:staging

# Convert Firebase config to .env.production
npm run firebase:convert:production
```

This utility converts the standard Firebase web app configuration (from the Firebase Console) to the `.env` format used by this project. See `scripts/README.md` for detailed usage instructions.

### `.env.emulator`
Pre-configured for Firebase emulators. This file is loaded when using `npm run dev:local` or `--mode emulator`. Uses localhost ports:
- Firestore: localhost:8080
- Auth: localhost:9099

Note: `.env.local` is also available and loaded by Vite in all non-production modes, but `.env.emulator` is the primary configuration for local development.

### `.env.staging`
Template for staging environment. **Requires manual configuration** with your staging Firebase project credentials, or use the Firebase config converter utility.

### `.env.production`
Pre-configured with production Firebase credentials. Ready to use.

### `.env.example`
Comprehensive documentation of all available environment variables. Use as a reference.

### `.env`
Your active environment configuration. Created by:
- Running `npm run env:*` commands
- Manually copying an `.env.*` file
- Creating from `.env.example`

**Note:** `.env` is git-ignored and won't be committed.

## Environment Variables

### Core Variables

- `VITE_FIREBASE_ENV` - Environment mode: `local`, `staging`, or `production`

### Production Variables

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`

### Staging Variables

Same as production but prefixed with `STAGING`:
- `VITE_FIREBASE_STAGING_API_KEY`
- `VITE_FIREBASE_STAGING_AUTH_DOMAIN`
- etc.

### Local/Emulator Variables

- `VITE_FIREBASE_LOCAL_PROJECT_ID` - Project ID for emulators
- `VITE_EMULATOR_FIRESTORE_HOST` - Firestore emulator host (default: localhost)
- `VITE_EMULATOR_FIRESTORE_PORT` - Firestore emulator port (default: 8080)
- `VITE_EMULATOR_AUTH_HOST` - Auth emulator host (default: localhost)
- `VITE_EMULATOR_AUTH_PORT` - Auth emulator port (default: 9099)

## Building for Different Environments

```bash
# Build for local (emulators)
npm run build:local

# Build for staging
npm run build:staging

# Build for production
npm run build:production
```

## Troubleshooting

### Environment not switching
- Check that you're using the correct npm script
- Verify the `.env` file contains the expected values
- Restart the dev server after changing environments

### Emulators not connecting
- Ensure Firebase emulators are running: `npm run emulators`
- Check that ports 8080 and 9099 are not in use
- Verify `VITE_FIREBASE_ENV=local` in your environment

### Staging environment not working
- Confirm you've added your staging Firebase credentials to `.env.staging`
- Check that all required variables are set
- Verify your staging Firebase project exists and is properly configured

### Production data appearing in development
- Double-check which environment you're running
- Look for the console messages showing Firebase environment and project
- Switch to local or staging environment for development

## Console Output

When the application starts, you'll see console messages indicating the active environment:

```
🔥 Firebase Environment: local
📦 Firebase Project: dobutsu-admin
🔧 Connected to Firestore emulator at localhost:8080
🔧 Connected to Auth emulator at localhost:9099
```

or

```
🔥 Firebase Environment: production
📦 Firebase Project: dobutsu-stationery-6b227
```

## Best Practices

1. **Use local environment for daily development** - It's faster and safer
2. **Use staging for testing** - Test with real Firebase before production
3. **Use production sparingly** - Only when necessary for live operations
4. **Export emulator data regularly** - Save interesting test scenarios
5. **Never commit `.env`** - It's git-ignored for a reason
6. **Document staging setup** - If you create a staging project, document the credentials securely

## Security Notes

- All `.env.*` template files are committed to git (they're templates)
- Your personal `.env` file is git-ignored
- Production credentials are already in `.env.production` (Firebase config is public by design)
- Staging credentials should be added manually and not committed if they're sensitive
- For production deployments, consider using Firebase hosting environment configuration

## Additional Resources

- [Firebase Emulator Suite](https://firebase.google.com/docs/emulator-suite)
- [Vite Environment Variables](https://vitejs.dev/guide/env-and-mode.html)
- [SvelteKit Environment Variables](https://kit.svelte.dev/docs/modules#$env-static-public)
