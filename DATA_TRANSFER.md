# Data Transfer Tool

A command-line tool for transferring Firestore data between environments (production → staging/emulator).

## Overview

This tool enables you to:
- **Export** data from production or staging Firestore
- **Import** data to staging or local emulator
- **Transfer** data directly from one environment to another
- **Backup** production data for safekeeping

## Prerequisites

### For Production/Staging Environments

You need a Firebase service account key for each non-emulator environment:

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Navigate to: **Project Settings** → **Service Accounts**
4. Click **Generate New Private Key**
5. Save the downloaded JSON file as:
   - `service-account-production.json` (for production)
   - `service-account-staging.json` (for staging)
6. Place the file in the root directory of this project

**⚠️ Security Warning**: Never commit service account keys to version control! These files are already in `.gitignore`.

### For Emulator Environment

No service account needed. Just ensure the Firebase emulators are running:

```bash
npm run emulators
```

## Installation

Install the required dependency:

```bash
npm install
```

This will install `firebase-admin` which is needed for the data transfer operations.

## Usage

### Export Data

Export data from an environment to a local directory:

```bash
# Export from production
npm run data:export -- --source production --output ./data-export

# Export from staging
npm run data:export -- --source staging --output ./data-export

# Export from emulator
npm run data:export -- --source emulator --output ./data-export
```

This creates a `firestore-export.json` file in the output directory containing all exported data.

### Import Data

Import previously exported data to an environment:

```bash
# Import to emulator (for local development)
npm run data:import -- --target emulator --input ./data-export

# Import to staging
npm run data:import -- --target staging --input ./data-export
```

**⚠️ Warning**: Import will overwrite existing documents with the same IDs!

### Transfer Data Directly

Transfer data from one environment to another in a single command:

```bash
# Production → Emulator (most common use case)
npm run data:transfer -- --from production --to emulator

# Production → Staging
npm run data:transfer -- --from production --to staging

# Staging → Emulator
npm run data:transfer -- --from staging --to emulator
```

This is equivalent to running export followed by import, but more convenient.

## Options

### Time Filtering

By default, only the last 30 days of broadcast actions are exported to avoid transferring stale data:

```bash
# Export only last 7 days
npm run data:export -- --source production --output ./data --days 7

# Export all broadcast history
npm run data:export -- --source production --output ./data --days 0
```

### Collection Selection

Control which collections are transferred:

```bash
# Skip broadcast collection (action history)
npm run data:transfer -- --from production --to emulator --skip-broadcast

# Skip users collection
npm run data:transfer -- --from production --to emulator --skip-users

# Include orders (dobutsu collection) - not included by default
npm run data:transfer -- --from production --to emulator --include-orders
```

### Combined Options

```bash
# Export production inventory only (no broadcast, no users, with orders)
npm run data:export -- \
  --source production \
  --output ./data \
  --skip-broadcast \
  --skip-users \
  --include-orders
```

## Collections

### Transferred by Default

1. **`broadcast`** - Action history for state synchronization
   - Contains Redux actions that modify inventory state
   - Filtered by time (last 30 days by default) to reduce size

2. **`users`** - Admin user data
   - User profiles and activity timestamps
   - Small dataset, always fully transferred

### Optional Collections

3. **`dobutsu`** - Orders and payments
   - Contains order details and PayPal payment information
   - Only transferred with `--include-orders` flag
   - Can be large depending on order volume

## Common Workflows

### Scenario 1: Test with Production Data Locally

```bash
# 1. Start Firebase emulators
npm run emulators

# 2. In another terminal, transfer data
npm run data:transfer -- --from production --to emulator

# 3. Start the app connected to emulator
npm run dev:local
```

### Scenario 2: Populate Staging Environment

```bash
# Transfer recent data to staging
npm run data:transfer -- --from production --to staging --days 7
```

### Scenario 3: Create a Backup

```bash
# Export all data including orders
npm run data:export -- \
  --source production \
  --output ./backup-2025-10-26 \
  --days 0 \
  --include-orders

# Store the backup directory safely
```

### Scenario 4: Restore from Backup

```bash
# Import from a specific backup
npm run data:import -- --target staging --input ./backup-2025-10-26
```

## Data Format

Exported data is stored in JSON format in `firestore-export.json`:

```json
{
  "exportedAt": "2025-10-26T12:00:00.000Z",
  "collections": {
    "broadcast": [
      {
        "id": "doc-id-123",
        "data": {
          "type": "update_item",
          "payload": { ... },
          "timestamp": "2025-10-26T12:00:00.000Z",
          "creator": "user-uid"
        }
      }
    ],
    "users": [ ... ]
  }
}
```

Firestore Timestamps are automatically converted to ISO 8601 strings for JSON serialization and converted back during import.

## Troubleshooting

### "Service account key not found"

**Problem**: Missing service account JSON file

**Solution**: Download the service account key from Firebase Console and save it as `service-account-production.json` or `service-account-staging.json` in the project root.

### "Cannot connect to emulator"

**Problem**: Firebase emulators not running

**Solution**: Start emulators in a separate terminal:
```bash
npm run emulators
```

### "Permission denied"

**Problem**: Service account lacks necessary permissions

**Solution**: Ensure the service account has "Cloud Datastore User" role or higher in Firebase Console → IAM & Admin.

### Import is slow

**Problem**: Large datasets take time to import

**Solution**: 
- Use `--days 7` to limit broadcast history
- Use `--skip-broadcast` if you don't need action history
- Be patient - Firestore batches writes for safety

## Best Practices

1. **Always backup before importing**: Export current state before importing data
2. **Test locally first**: Use emulator to test transfers before touching staging/production
3. **Use time filtering**: Don't transfer unnecessary historical data
4. **Secure service accounts**: Keep service account keys out of version control
5. **Document transfers**: Note when and why you transferred data in your team's records

## Security Considerations

- Service account keys grant full access to Firestore - treat them like passwords
- Never commit service account keys to git (they're in `.gitignore`)
- Rotate service account keys periodically
- Use different service accounts for production vs staging
- Consider using read-only service accounts for export-only operations

## Limitations

- Does not transfer Firestore security rules (manage those separately via Firebase Console)
- Does not transfer indexes (defined in `firestore.indexes.json`)
- Large datasets (>100k documents) may require batching modifications
- Firestore has a 500-document batch write limit (handled automatically by the script)
- Transfer does not preserve exact creation timestamps (uses current time)

## Advanced Usage

### Environment Variables

You can customize emulator connection:

```bash
# Use non-standard emulator host/port
export FIRESTORE_EMULATOR_HOST=localhost:9999
npm run data:transfer -- --from production --to emulator
```

### Programmatic Usage

The script can be imported and used programmatically:

```javascript
import { execSync } from 'child_process';

// Export data
execSync('node scripts/transfer-data.js --source production --output ./data');

// Process data...

// Import modified data
execSync('node scripts/transfer-data.js --target staging --input ./data');
```

## See Also

- [Firebase Emulator Documentation](https://firebase.google.com/docs/emulator-suite)
- [Firestore Data Export/Import](https://firebase.google.com/docs/firestore/manage-data/export-import)
- [ENVIRONMENT_SETUP.md](../ENVIRONMENT_SETUP.md) - Environment configuration guide
- [README.md](../README.md) - General project documentation
