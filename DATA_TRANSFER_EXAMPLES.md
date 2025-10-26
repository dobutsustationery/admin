# Data Transfer Tool - Quick Start Examples

This guide provides step-by-step examples for common data transfer scenarios.

## Prerequisites Checklist

Before using the data transfer tool, ensure you have:

- [ ] Node.js 18+ installed
- [ ] Dependencies installed: `npm install`
- [ ] Service account keys downloaded (for reading):
  - [ ] `service-account-production.json` (for reading from production)
  - [ ] `service-account-staging.json` (for reading/writing to staging)
- [ ] **For writing to production** (rare):
  - [ ] `service-account-production-write.json` (special write credentials)
  - [ ] Understanding of `--force` flag requirement
- [ ] Firebase emulators installed (if using emulator): `npm install -g firebase-tools`

## Example 1: Test Locally with Production Data

**Goal**: Set up a local development environment with real production inventory data.

**Steps**:

```bash
# 1. Ensure you have the production service account key
# Place it in the project root as: service-account-production.json

# 2. Start the Firebase emulators in one terminal
npm run emulators

# 3. In another terminal, transfer data from production to emulator
npm run data:transfer -- --from production --to emulator

# 4. Start the development server
npm run dev:local

# 5. Open http://localhost:5173 and verify data is loaded
```

**Notes**:
- This transfers the complete broadcast action history (required for app to function)
- Users collection is included
- Orders (dobutsu collection) are included by default

## Example 2: Populate Staging with Fresh Production Data

**Goal**: Update the staging environment with the latest production data for QA testing.

**Steps**:

```bash
# 1. Ensure you have both service account keys:
#    - service-account-production.json
#    - service-account-staging.json

# 2. Transfer all data from production to staging
npm run data:transfer -- --from production --to staging

# 3. Verify by accessing your staging URL
```

**Notes**:
- This transfers the complete dataset (all broadcast history, users, and orders)
- Essential for keeping staging environment in sync with production

## Example 3: Create a Production Backup

**Goal**: Export and save production data for backup purposes.

**Steps**:

```bash
# 1. Create a backup directory with today's date
mkdir -p backups/backup-$(date +%Y-%m-%d)

# 2. Export all production data (broadcast, users, orders)
npm run data:export -- \
  --source production \
  --output backups/backup-$(date +%Y-%m-%d)

# 3. Verify the export
ls -lh backups/backup-$(date +%Y-%m-%d)/firestore-export.json

# 4. (Optional) Compress the backup
cd backups && tar -czf backup-$(date +%Y-%m-%d).tar.gz backup-$(date +%Y-%m-%d)
```

**Notes**:
- Exports complete broadcast history with exact timestamps
- Includes all collections (broadcast, users, and orders) by default
- Store backups securely; they contain sensitive data

## Example 4: Restore from a Backup

**Goal**: Restore staging environment from a previous backup.

**Steps**:

```bash
# 1. List available backups
ls -lt backups/

# 2. Restore from a specific backup to staging
npm run data:import -- \
  --target staging \
  --input backups/backup-2025-10-20

# 3. Verify the data in staging environment
```

**Warning**: This will overwrite existing data in staging!

## Example 4b: Restore to Production (Emergency Recovery)

**Goal**: Restore production from a backup in case of data loss or corruption.

**⚠️ EXTREME CAUTION REQUIRED** - Only do this in an emergency!

**Steps**:

```bash
# 1. Ensure you have production write credentials
# Place service-account-production-write.json in project root

# 2. Create a backup of current production state FIRST
npm run data:export -- \
  --source production \
  --output ./backup-before-restore-$(date +%Y-%m-%d-%H%M%S)

# 3. Restore from backup to production (requires --force)
npm run data:import -- \
  --target production \
  --input backups/backup-2025-10-20 \
  --force

# 4. Verify the data in production
```

**Critical Notes**:
- **ALWAYS backup current production first** before restoring
- Requires `service-account-production-write.json` (separate from read credentials)
- Must use `--force` flag
- Script will show warnings - read them carefully
- Consider testing restore in staging first
- This will **OVERWRITE** all production data!

## Example 5: Transfer Without Orders

**Goal**: Transfer broadcast and users data, but exclude orders.

**Steps**:

```bash
# Export without orders
npm run data:export -- \
  --source production \
  --output ./data-no-orders \
  --skip-orders

# Import to emulator
npm run data:import -- \
  --target emulator \
  --input ./data-no-orders
```

**Notes**:
- Complete broadcast history is still transferred (required for app to function)
- Only orders are excluded
- Useful when orders contain sensitive customer information

## Example 6: Migrate Data Between Projects

**Goal**: Copy data from one Firebase project to another (e.g., when creating a new staging project).

**Steps**:

```bash
# 1. Export from source project (using its service account)
npm run data:export -- \
  --source production \
  --output ./migration-data

# 2. Manually update service-account-staging.json to point to the new project

# 3. Import to the new project
npm run data:import -- \
  --target staging \
  --input ./migration-data
```

**Notes**:
- Exports complete dataset with all collections
- Timestamps are preserved with full precision for exact action replay
- Ensure the new project has the same Firestore structure
- Consider setting up security rules before importing

## Troubleshooting Common Issues

### Issue: "Service account key not found"

**Solution**:
```bash
# Check if the file exists in the project root
ls -la service-account-*.json

# If missing, download from Firebase Console:
# 1. Go to https://console.firebase.google.com
# 2. Select your project
# 3. Project Settings > Service Accounts
# 4. Generate New Private Key
# 5. Save as service-account-production.json or service-account-staging.json
```

### Issue: "Cannot connect to emulator"

**Solution**:
```bash
# Make sure emulators are running
# In a separate terminal:
npm run emulators

# Wait for the message: "All emulators ready!"
# Then run your transfer command
```

### Issue: "Permission denied" when accessing Firestore

**Solution**:
- Ensure the service account has "Cloud Datastore User" role
- Check in Firebase Console > IAM & Admin
- Regenerate the service account key if needed

### Issue: Transfer is very slow

**Solution**:
```bash
# Large datasets take time - be patient
# The broadcast collection requires all historical data for the app to function
# Firestore batches writes (500 documents per batch) for safety

# If you only need users/orders without broadcast history (not recommended):
npm run data:transfer -- --from production --to emulator --skip-broadcast
```

**Note**: Skipping broadcast history will prevent the application from functioning correctly. The system requires the complete action history to reconstruct state.

## Best Practices

1. **Test First**: Always test transfers on emulator before touching staging/production
2. **Backup Before Import**: Create a backup before importing data to any environment
3. **Transfer Complete Data**: Include all broadcast history for app to function correctly
4. **Secure Keys**: Never commit service account keys to version control
5. **Document Transfers**: Keep a log of when and why you transferred data

## Advanced Tips

### Custom Emulator Port

If your emulator runs on a different port:

```bash
export FIRESTORE_EMULATOR_HOST=localhost:9999
npm run data:transfer -- --from production --to emulator
```

### Scripted Workflow

Create a shell script for regular tasks:

```bash
#!/bin/bash
# weekly-staging-refresh.sh

BACKUP_DIR="backups/backup-$(date +%Y-%m-%d)"

echo "Creating backup..."
npm run data:export -- --source staging --output "$BACKUP_DIR"

echo "Refreshing staging with production data..."
npm run data:transfer -- --from production --to staging

echo "Done! Backup saved at $BACKUP_DIR"
```

Make it executable and run:
```bash
chmod +x weekly-staging-refresh.sh
./weekly-staging-refresh.sh
```

## See Also

- [DATA_TRANSFER.md](DATA_TRANSFER.md) - Complete reference documentation
- [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) - Environment configuration guide
- [Firebase Documentation](https://firebase.google.com/docs/firestore) - Firestore documentation
