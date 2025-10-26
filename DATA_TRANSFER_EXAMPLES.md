# Data Transfer Tool - Quick Start Examples

This guide provides step-by-step examples for common data transfer scenarios.

## Prerequisites Checklist

Before using the data transfer tool, ensure you have:

- [ ] Node.js 18+ installed
- [ ] Dependencies installed: `npm install`
- [ ] Service account keys downloaded (for production/staging):
  - [ ] `service-account-production.json` (if transferring from/to production)
  - [ ] `service-account-staging.json` (if transferring from/to staging)
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
- This transfers the last 30 days of broadcast actions by default
- Users collection is included
- Orders are NOT included by default (add `--include-orders` if needed)

## Example 2: Populate Staging with Fresh Production Data

**Goal**: Update the staging environment with the latest production data for QA testing.

**Steps**:

```bash
# 1. Ensure you have both service account keys:
#    - service-account-production.json
#    - service-account-staging.json

# 2. Transfer directly from production to staging
npm run data:transfer -- --from production --to staging --days 7

# 3. Verify by accessing your staging URL
```

**Notes**:
- This example only transfers the last 7 days of data
- Useful for keeping staging data fresh without full history

## Example 3: Create a Production Backup

**Goal**: Export and save production data for backup purposes.

**Steps**:

```bash
# 1. Create a backup directory with today's date
mkdir -p backups/backup-$(date +%Y-%m-%d)

# 2. Export all production data including orders
npm run data:export -- \
  --source production \
  --output backups/backup-$(date +%Y-%m-%d) \
  --days 0 \
  --include-orders

# 3. Verify the export
ls -lh backups/backup-$(date +%Y-%m-%d)/firestore-export.json

# 4. (Optional) Compress the backup
cd backups && tar -czf backup-$(date +%Y-%m-%d).tar.gz backup-$(date +%Y-%m-%d)
```

**Notes**:
- `--days 0` includes all broadcast history, not just recent
- `--include-orders` includes the dobutsu collection with order data
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

## Example 5: Transfer Only Inventory (No Actions History)

**Goal**: Transfer just the current inventory state without action history.

**Steps**:

```bash
# Export without broadcast actions
npm run data:export -- \
  --source production \
  --output ./inventory-snapshot \
  --skip-broadcast

# Import to emulator
npm run data:import -- \
  --target emulator \
  --input ./inventory-snapshot
```

**Notes**:
- Skipping broadcast means you only get the current state
- The app will still work but won't have action history for debugging
- Much faster for large datasets

## Example 6: Migrate Data Between Projects

**Goal**: Copy data from one Firebase project to another (e.g., when creating a new staging project).

**Steps**:

```bash
# 1. Export from source project (using its service account)
npm run data:export -- \
  --source production \
  --output ./migration-data \
  --days 0 \
  --include-orders

# 2. Manually update service-account-staging.json to point to the new project

# 3. Import to the new project
npm run data:import -- \
  --target staging \
  --input ./migration-data
```

**Notes**:
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
# Reduce the amount of data being transferred:

# Option 1: Limit days
npm run data:transfer -- --from production --to emulator --days 7

# Option 2: Skip broadcast history entirely
npm run data:transfer -- --from production --to emulator --skip-broadcast

# Option 3: Skip users if not needed
npm run data:transfer -- --from production --to emulator --skip-users
```

## Best Practices

1. **Test First**: Always test transfers on emulator before touching staging/production
2. **Backup Before Import**: Create a backup before importing data to any environment
3. **Use Time Filters**: Don't transfer more data than you need
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
npm run data:transfer -- --from production --to staging --days 7

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
