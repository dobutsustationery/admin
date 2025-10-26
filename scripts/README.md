# Firebase Config to .env Converter

This utility converts Firebase's standard web configuration object into the `.env` file format used by this project.

## Purpose

When you set up a Firebase project for web, the Firebase Console provides configuration in this format:

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc...",
  measurementId: "G-ABC..."
};
```

This utility converts it to the `.env` format needed by this application:

```env
# Production Environment
VITE_FIREBASE_ENV=production

# Firebase Configuration
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc...
VITE_FIREBASE_MEASUREMENT_ID=G-ABC...
```

## Usage

### Quick Start

The easiest way to use this utility is with the npm scripts:

```bash
# For staging environment
npm run firebase:convert:staging

# For production environment
npm run firebase:convert:production
```

These commands will:
1. Prompt you to paste your Firebase config
2. Convert it to the appropriate format
3. Save it to `.env.staging` or `.env.production`

### Command Line Options

Run the script directly for more control:

```bash
# Show help
node scripts/firebase-config-to-env.js --help

# Interactive mode (paste config, output to stdout)
node scripts/firebase-config-to-env.js

# Convert staging config from a file
node scripts/firebase-config-to-env.js --env staging --input firebase-config.json --output .env.staging

# Convert production config from a file
node scripts/firebase-config-to-env.js --env production --input firebase-config.json --output .env.production
```

### Options

- `--env, -e <env>` - Environment: `staging` or `production` (default: `production`)
- `--input, -i <file>` - Read Firebase config from a JSON file
- `--output, -o <file>` - Write output to a file instead of stdout
- `--help, -h` - Show help message

## Input Formats

The utility accepts Firebase config in multiple formats:

### JSON Format

```json
{
  "apiKey": "AIza...",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project",
  "storageBucket": "your-project.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "1:123456789:web:abc...",
  "measurementId": "G-ABC..."
}
```

### JavaScript Object Format

```javascript
const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc...",
  measurementId: "G-ABC..."
};
```

The utility automatically handles:
- Variable declarations (`const`, `var`, `let`)
- Single-line comments (`//`)
- Multi-line comments (`/* */`)
- Trailing semicolons
- Both quoted and unquoted keys
- Single or double quotes

## Examples

### Example 1: Create a new staging environment file

1. Go to Firebase Console
2. Navigate to Project Settings > General
3. Under "Your apps", find your web app configuration
4. Copy the configuration object
5. Run the converter:

```bash
npm run firebase:convert:staging
```

6. Paste your config and press Ctrl+D (Cmd+D on Mac)
7. The file `.env.staging` will be created

### Example 2: Convert from a saved config file

If you saved your Firebase config to a file:

```bash
node scripts/firebase-config-to-env.js --input my-firebase-config.json --env production --output .env.production
```

### Example 3: Preview without saving

To see what the output will look like without saving to a file:

```bash
node scripts/firebase-config-to-env.js --input firebase-config.json
```

## Environment Differences

### Production

For production environment (`--env production`):
- Creates variables with `VITE_FIREBASE_` prefix
- Example: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_PROJECT_ID`

### Staging

For staging environment (`--env staging`):
- Creates variables with `VITE_FIREBASE_STAGING_` prefix
- Example: `VITE_FIREBASE_STAGING_API_KEY`, `VITE_FIREBASE_STAGING_PROJECT_ID`

This allows the application to use different Firebase projects for staging and production.

## Required Fields

The utility validates that all required Firebase configuration fields are present:

- `apiKey` - Your API key (required)
- `authDomain` - Authentication domain (required)
- `projectId` - Project ID (required)
- `storageBucket` - Storage bucket (required)
- `messagingSenderId` - Messaging sender ID (required)
- `appId` - App ID (required)
- `measurementId` - Measurement ID (optional)

If any required field is missing, the utility will display an error message.

## Integration with Environment Switching

After creating your `.env.staging` or `.env.production` file, you can use it with the environment switching scripts:

```bash
# Set staging as default environment
npm run env:staging

# Or run directly in staging mode
npm run dev:staging
```

See [ENVIRONMENT_SETUP.md](../ENVIRONMENT_SETUP.md) for more details on environment management.

## Troubleshooting

### "Could not parse Firebase config"

- Ensure you copied the complete config object
- Check that all braces and quotes are properly closed
- Try saving to a file first and using `--input`

### "Missing required fields"

- Verify you copied the complete Firebase config from the console
- Check that you didn't accidentally omit any fields
- Ensure the config includes at minimum: `apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, and `appId`

### "Invalid environment"

- Use either `staging` or `production` for the `--env` option
- The default is `production` if not specified
