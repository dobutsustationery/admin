# Data Transfer Tool

A command-line tool for transferring Firestore data between environments (production → staging/emulator).

## Quick Start

**New to this tool?** Check out [DATA_TRANSFER_EXAMPLES.md](DATA_TRANSFER_EXAMPLES.md) for step-by-step examples and common scenarios.

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
   - `service-account-production.json` (for **reading** from production)
   - `service-account-staging.json` (for staging)
6. Place the file in the root directory of this project

**⚠️ Security Warning**: Never commit service account keys to version control! These files are already in `.gitignore`.

### For Writing to Production (Extra Protection)

**Writing data to production is dangerous!** To prevent accidental overwrites, additional safeguards are required:

1. **Special Write Credentials**: Create a separate service account with write permissions
   - Go to Firebase Console → IAM & Admin → Service Accounts
   - Create a new service account (e.g., "Firestore Data Import Writer")
   - Grant it "Cloud Datastore User" role
   - Generate and download the key
   - Save as: `service-account-production-write.json`
   - **Keep this file extremely secure** - it has write access to production!

2. **Force Flag Required**: You must explicitly add `--force` to any command that writes to production
   - This prevents accidental production writes
   - The script will refuse to run without this flag

3. **Example**:
   ```bash
   # This will FAIL (missing --force)
   npm run data:import -- --target production --input ./backup
   
   # This will WORK (with --force)
   npm run data:import -- --target production --input ./backup --force
   ```

**Note**: Reading from production (exports) does NOT require special credentials or `--force` flag.

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

# Import to PRODUCTION (requires --force and special credentials)
npm run data:import -- --target production --input ./data-export --force
```

**⚠️ Warning**: Import will overwrite existing documents with the same IDs!

**🔒 Production Write Protection**: Importing to production requires:
- `--force` flag
- `service-account-production-write.json` credentials

### Transfer Data Directly

Transfer data from one environment to another in a single command:

```bash
# Production → Emulator (most common use case)
npm run data:transfer -- --from production --to emulator

# Production → Staging (writing to production requires --force)
npm run data:transfer -- --from staging --to production --force

# Staging → Emulator
npm run data:transfer -- --from staging --to emulator
```

**🔒 Production Write Protection**: When transferring TO production, you must:
- Add `--force` flag to the command
- Have `service-account-production-write.json` credentials

This is equivalent to running export followed by import, but more convenient.

## Options

### Collection Selection

Control which collections are transferred:

```bash
# Skip broadcast collection (not recommended - app needs full history)
npm run data:transfer -- --from production --to emulator --skip-broadcast

# Skip users collection
npm run data:transfer -- --from production --to emulator --skip-users

# Skip orders (dobutsu collection)
npm run data:transfer -- --from production --to emulator --skip-orders
```

**⚠️ Important**: The broadcast collection contains the complete action history that is required to reconstruct the application state. Skipping it is not recommended for normal use.

### Combined Options

```bash
# Export only users (skip broadcast and orders)
npm run data:export -- \
  --source production \
  --output ./data \
  --skip-broadcast \
  --skip-orders
```

## Collections

### Transferred by Default

1. **`broadcast`** - Complete action history for state synchronization
   - Contains all Redux actions that modify inventory state
   - **Required** for the application to function correctly
   - Actions must be replayed in exact order with precise timestamps

2. **`users`** - Admin user data
   - User profiles and activity timestamps
2. **`users`** - Admin user data
   - User profiles and activity timestamps
   - Small dataset, always fully transferred

3. **`dobutsu`** - Orders and payments
   - Contains order details and PayPal payment information
   - Transferred by default (use `--skip-orders` to exclude)
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
# Transfer all data to staging
npm run data:transfer -- --from production --to staging
```

### Scenario 3: Create a Backup

```bash
# Export all data (broadcast, users, and orders)
npm run data:export -- \
  --source production \
  --output ./backup-2025-10-26

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
          "timestamp": {
            "_timestamp": true,
            "_seconds": 1729944000,
            "_nanoseconds": 123456789
          },
          "creator": "user-uid"
        }
      }
    ],
    "users": [ ... ],
    "dobutsu": [ ... ]
  }
}
```

**Timestamp Preservation**: Firestore Timestamps are preserved with full precision (seconds and nanoseconds) to ensure actions can be replayed in the exact order they occurred. This is critical for the application's state reconstruction.

## Troubleshooting

### "Writing to production requires --force flag"

**Problem**: Attempting to import or transfer data to production without the `--force` flag

**Solution**: This is a safety feature. Add `--force` to your command:
```bash
npm run data:import -- --target production --input ./backup --force
```

**Why**: This prevents accidental overwrites of production data.

### "Production write credentials not found"

**Problem**: Missing `service-account-production-write.json` file

**Solution**: 
1. Go to Firebase Console → IAM & Admin → Service Accounts
2. Create a new service account with write permissions
3. Grant it "Cloud Datastore User" role
4. Download the key and save as `service-account-production-write.json`
5. Keep this file secure - it has write access to production!

**Why**: Production writes require separate, more restricted credentials than read operations.

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
- Be patient - Firestore batches writes (500 documents at a time) for safety
- The broadcast collection requires all historical data to function correctly
- Consider the time investment as necessary for data integrity

## Best Practices

1. **Always backup before importing**: Export current state before importing data
2. **Test locally first**: Use emulator to test transfers before touching staging/production
3. **Transfer complete data**: The application requires full broadcast history to function
4. **Secure service accounts**: Keep service account keys out of version control
5. **Document transfers**: Note when and why you transferred data in your team's records
6. **Never write to production casually**: Use the `--force` flag only when absolutely necessary

## Security Considerations

### General Security
- Service account keys grant full access to Firestore - treat them like passwords
- Never commit service account keys to git (they're in `.gitignore`)
- Rotate service account keys periodically
- Use different service accounts for production vs staging

### Production Write Protection
This tool implements multiple layers of protection for production writes:

1. **Separate Credentials**: Production writes require `service-account-production-write.json`
   - Different from read-only `service-account-production.json`
   - Must be explicitly created and configured
   - Allows you to grant minimal write permissions only when needed

2. **Force Flag Required**: The `--force` flag must be explicitly added
   - Prevents accidental copy-paste errors
   - Makes production writes intentional and explicit
   - Script will exit with error message if flag is missing

3. **Warning Messages**: The script displays prominent warnings
   - Alerts you when writing to production
   - Reminds you to create backups first
   - Provides clear error messages if protection checks fail

**Recommendation**: Keep `service-account-production-write.json` in a secure location (not on developer laptops). Only copy it temporarily when needed for data migrations.

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

- **[DATA_TRANSFER_EXAMPLES.md](DATA_TRANSFER_EXAMPLES.md)** - Step-by-step examples and common scenarios
- [Firebase Emulator Documentation](https://firebase.google.com/docs/emulator-suite)
- [Firestore Data Export/Import](https://firebase.google.com/docs/firestore/manage-data/export-import)
- [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) - Environment configuration guide
- [README.md](README.md) - General project documentation
