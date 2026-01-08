# Google Drive and Sheets Integration - Design Document

## Overview

This document describes the design for integrating Google Drive and Google Sheets into the Dobutsu Stationery admin application. The integration will enable the admin site to access a dedicated folder in dobustustationery@gmail.com's Google Drive and create CSV files, log files, and Google Sheets documents directly from the application.

## Business Requirements

The admin site needs to:
1. Access a specific folder in dobustustationery@gmail.com's Google Drive
2. Create and upload CSV files for inventory exports
3. Create and upload log files for audit trails and debugging
4. Create Google Sheets documents for collaborative data management
5. List and manage files within the designated folder
6. Update existing files when needed (e.g., append to logs, update sheets)

## Integration Architecture

### Authentication & Authorization

#### Option 1: OAuth 2.0 User Authentication (Recommended for Admin Users)

This approach uses OAuth 2.0 to authenticate admin users and request access to Google Drive on their behalf.

**Configuration Steps:**

1. **Enable Google APIs in Google Cloud Console**
   - Navigate to https://console.cloud.google.com/
   - Select the Firebase project: `dobutsu-stationery-6b227`
   - Go to "APIs & Services" > "Library"
   - Enable the following APIs:
     - Google Drive API
     - Google Sheets API

2. **Create OAuth 2.0 Credentials**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: "Web application"
   - Name: "Dobutsu Admin - Drive Integration"
   - Authorized JavaScript origins:
     - `http://localhost:5173` (development)
     - `https://admin.dobutsustationery.com` (production)
     - Add staging URL if applicable
   - Authorized redirect URIs:
     - `http://localhost:5173/auth/google/callback` (development)
     - `https://admin.dobutsustationery.com/auth/google/callback` (production)
   - Save the Client ID and Client Secret

3. **Configure OAuth Consent Screen**
   - Go to "APIs & Services" > "OAuth consent screen"
   - User type: "Internal" (if using Google Workspace) or "External"
   - Application name: "Dobutsu Stationery Admin"
   - User support email: dobustustationery@gmail.com
   - Developer contact: dobustustationery@gmail.com
   - Scopes to add:
     - `https://www.googleapis.com/auth/drive.file` (access to files created by the app)
     - OR `https://www.googleapis.com/auth/drive` (full drive access, if needed)
     - `https://www.googleapis.com/auth/spreadsheets` (Google Sheets access)

4. **Environment Variables**
   Add to `.env.production`, `.env.staging`, and `.env.local`:
   ```
   VITE_GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   VITE_GOOGLE_DRIVE_API_KEY=your-api-key (optional, for public data access)
   VITE_GOOGLE_DRIVE_FOLDER_ID=folder-id-from-drive-url
   ```

**OAuth Flow:**

1. User clicks "Connect to Google Drive" button in the admin interface
2. Application redirects to Google's OAuth consent page
3. User grants permission to access Drive and Sheets
4. Google redirects back with authorization code
5. Application exchanges code for access token and refresh token
6. Tokens are stored securely (Firebase Firestore with encryption or browser localStorage)
7. Access token is used for API calls; refresh token renews expired access tokens

**Security Considerations:**

- Access tokens expire after 1 hour; refresh tokens must be used to obtain new access tokens
- Store refresh tokens securely in Firestore with user-level encryption
- Implement token rotation and revocation mechanisms
- Use PKCE (Proof Key for Code Exchange) for additional security
- Only request minimum necessary scopes

#### Option 2: Service Account (Alternative for Server-Side Operations)

This approach uses a service account for backend operations without user interaction.

**Configuration Steps:**

1. **Create Service Account**
   - Go to Google Cloud Console > "IAM & Admin" > "Service Accounts"
   - Click "Create Service Account"
   - Name: "dobutsu-admin-drive-service"
   - Grant role: "Editor" (or custom role with Drive/Sheets permissions)
   - Create and download JSON key file

2. **Share Drive Folder with Service Account**
   - Open the designated Drive folder as dobustustationery@gmail.com
   - Click "Share"
   - Add the service account email (format: `service-account-name@project-id.iam.gserviceaccount.com`)
   - Grant "Editor" permissions

3. **Secure Service Account Key**
   - **NEVER commit the JSON key file to git**
   - Store in Firebase Functions environment (if using Cloud Functions)
   - Or use Secret Manager for secure storage
   - Add key file path to `.gitignore`

4. **Environment Variables**
   ```
   # Service account approach (backend only)
   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
   GOOGLE_DRIVE_FOLDER_ID=folder-id-from-drive-url
   ```

**Use Cases:**

- Automated background jobs (e.g., nightly inventory exports)
- Server-side log aggregation
- Scheduled reports generation

**Security Considerations:**

- Service account keys provide full access; protect them carefully
- Rotate keys periodically (every 90 days recommended)
- Use Secret Manager instead of environment variables in production
- Implement IP allowlisting for service account usage
- Monitor service account activity in Cloud Logging

### API Integration Approach

#### Google Drive API

**Key Endpoints:**

1. **List Files in Folder**
   ```
   GET https://www.googleapis.com/drive/v3/files
   Query parameters:
   - q: "'FOLDER_ID' in parents and trashed=false"
   - fields: "files(id, name, mimeType, modifiedTime, size)"
   - orderBy: "modifiedTime desc"
   ```

2. **Upload File**
   ```
   POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart
   Body: multipart/related with metadata and file content
   Metadata JSON:
   {
     "name": "inventory-export-2024-12-02.csv",
     "parents": ["FOLDER_ID"],
     "mimeType": "text/csv"
   }
   ```

3. **Update File**
   ```
   PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media
   Body: new file content
   ```

4. **Delete File**
   ```
   DELETE https://www.googleapis.com/drive/v3/files/{fileId}
   ```

**File Types to Create:**

- **CSV Files**: `text/csv` - Inventory exports, order reports
- **Log Files**: `text/plain` - Application logs, audit trails
- **JSON Files**: `application/json` - Structured data exports

#### Google Sheets API

**Key Endpoints:**

1. **Create New Spreadsheet**
   ```
   POST https://sheets.googleapis.com/v4/spreadsheets
   Body:
   {
     "properties": {
       "title": "Inventory Report - 2024-12-02"
     },
     "sheets": [{
       "properties": {
         "title": "Inventory",
         "gridProperties": {
           "rowCount": 1000,
           "columnCount": 10
         }
       }
     }]
   }
   ```

2. **Write Data to Sheet**
   ```
   PUT https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}?valueInputOption=USER_ENTERED
   Body:
   {
     "range": "Inventory!A1:H100",
     "values": [
       ["JAN Code", "Subtype", "Description", "HS Code", "Qty", "Pieces", "Shipped"],
       ["4901234567890", "Blue", "Notebook A5", "4820.10", "50", "1", "10"],
       ...
     ]
   }
   ```

3. **Read Data from Sheet**
   ```
   GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}
   ```

4. **Format Cells**
   ```
   POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate
   Body: requests array with formatting operations
   ```

5. **Move Spreadsheet to Folder**
   After creating a spreadsheet, move it to the designated folder:
   ```
   PATCH https://www.googleapis.com/drive/v3/files/{spreadsheetId}?addParents={FOLDER_ID}&removeParents=root
   ```

**Sheet Templates:**

- **Inventory Sheet**: JAN Code, Subtype, Description, HS Code, Image, Qty, Pieces, Shipped
- **Orders Sheet**: Order ID, Date, Customer Email, Status, Items, Total
- **Audit Log Sheet**: Timestamp, User, Action, Details, Status
- **Low Stock Alert Sheet**: JAN Code, Description, Current Qty, Threshold, Reorder Needed

### NPM Packages Required

Add to `package.json`:

```json
{
  "dependencies": {
    "@googleapis/drive": "^8.0.0",
    "@googleapis/sheets": "^8.0.0",
    "googleapis": "^128.0.0"
  }
}
```

**Package Overview:**

- `googleapis`: Official Google APIs client library for Node.js
- `@googleapis/drive`: Dedicated Drive API client (alternative to full googleapis)
- `@googleapis/sheets`: Dedicated Sheets API client (alternative to full googleapis)

**Note**: If bundle size is a concern for the frontend, consider:
- Using only `@googleapis/drive` and `@googleapis/sheets` (smaller than full `googleapis`)
- Or making API calls from Firebase Cloud Functions instead of the client
- Or using the REST API directly with `fetch` (no package needed, but more manual work)

### Folder Structure in Google Drive

**Recommended Folder Hierarchy:**

```
Dobutsu Admin Exports/
├── Inventory/
│   ├── CSV Exports/
│   │   ├── inventory-2024-12-02.csv
│   │   └── inventory-2024-12-01.csv
│   └── Sheets/
│       ├── Monthly Inventory - Dec 2024
│       └── Low Stock Alerts
├── Orders/
│   ├── order-exports-2024-12.csv
│   └── Packed Orders Log.csv
├── Logs/
│   ├── Application Logs/
│   │   ├── app-log-2024-12-02.txt
│   │   └── error-log-2024-12-02.txt
│   └── Audit Trails/
│       ├── user-actions-2024-12.csv
│       └── inventory-changes-2024-12.csv
└── Reports/
    ├── Monthly Sales Report - Dec 2024
    └── Inventory Turnover Report
```

**Folder IDs Configuration:**

```env
# Main folder
VITE_GOOGLE_DRIVE_FOLDER_ID=main-folder-id

# Sub-folders (optional, for organized access)
VITE_GOOGLE_DRIVE_INVENTORY_FOLDER_ID=inventory-folder-id
VITE_GOOGLE_DRIVE_ORDERS_FOLDER_ID=orders-folder-id
VITE_GOOGLE_DRIVE_LOGS_FOLDER_ID=logs-folder-id
VITE_GOOGLE_DRIVE_REPORTS_FOLDER_ID=reports-folder-id
```

**Getting Folder IDs:**

1. Navigate to the folder in Google Drive
2. The URL will be: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
3. Copy the `FOLDER_ID_HERE` part
4. Add to environment variables

### Implementation Patterns

#### Pattern 1: CSV Export to Drive

**Current Implementation** (from `/csv` route):
- Generates CSV in memory using `@json2csv/plainjs`
- Displays in browser as `<pre>` text

**Enhanced Implementation with Drive:**

```typescript
// Example pseudocode (not actual implementation)
import { google } from 'googleapis';

async function exportInventoryToDrive(inventoryData, accessToken) {
  const drive = google.drive({ version: 'v3', auth: accessToken });
  
  // Generate CSV
  const parser = new Parser({ fields });
  const csvContent = parser.parse(inventoryData);
  
  // Create file metadata
  const fileName = `inventory-export-${new Date().toISOString().split('T')[0]}.csv`;
  const fileMetadata = {
    name: fileName,
    parents: [process.env.VITE_GOOGLE_DRIVE_INVENTORY_FOLDER_ID],
    mimeType: 'text/csv'
  };
  
  // Upload to Drive
  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: 'text/csv',
      body: csvContent
    },
    fields: 'id, name, webViewLink'
  });
  
  return {
    fileId: response.data.id,
    fileName: response.data.name,
    viewLink: response.data.webViewLink
  };
}
```

#### Pattern 2: Create Google Sheet from Inventory

```typescript
// Example pseudocode (not actual implementation)
import { google } from 'googleapis';

async function createInventorySheet(inventoryData, accessToken) {
  const sheets = google.sheets({ version: 'v4', auth: accessToken });
  const drive = google.drive({ version: 'v3', auth: accessToken });
  
  // Create spreadsheet
  const createResponse = await sheets.spreadsheets.create({
    requestBody: {
      properties: {
        title: `Inventory - ${new Date().toLocaleDateString()}`
      },
      sheets: [{
        properties: {
          title: 'Inventory',
          gridProperties: { frozenRowCount: 1 }
        }
      }]
    }
  });
  
  const spreadsheetId = createResponse.data.spreadsheetId;
  
  // Prepare data rows
  const headers = ['JAN Code', 'Subtype', 'Description', 'HS Code', 'Qty', 'Pieces', 'Shipped'];
  const rows = inventoryData.map(item => [
    item.janCode,
    item.subtype,
    item.description,
    item.hsCode,
    item.qty,
    item.pieces,
    item.shipped
  ]);
  
  // Write data
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Inventory!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [headers, ...rows]
    }
  });
  
  // Format header row
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: 0,
            startRowIndex: 0,
            endRowIndex: 1
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.2, green: 0.5, blue: 0.8 },
              textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } }
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]
    }
  });
  
  // Move to designated folder
  await drive.files.update({
    fileId: spreadsheetId,
    addParents: process.env.VITE_GOOGLE_DRIVE_INVENTORY_FOLDER_ID,
    removeParents: 'root'
  });
  
  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`
  };
}
```

#### Pattern 3: Append to Log File

```typescript
// Example pseudocode (not actual implementation)
async function appendToLogFile(logEntry, accessToken) {
  const drive = google.drive({ version: 'v3', auth: accessToken });
  
  const fileName = `app-log-${new Date().toISOString().split('T')[0]}.txt`;
  
  // Search for existing log file
  const searchResponse = await drive.files.list({
    q: `name='${fileName}' and '${process.env.VITE_GOOGLE_DRIVE_LOGS_FOLDER_ID}' in parents and trashed=false`,
    fields: 'files(id, name)'
  });
  
  let fileId;
  
  if (searchResponse.data.files.length > 0) {
    // File exists, download and append
    fileId = searchResponse.data.files[0].id;
    
    const existingContent = await drive.files.get({
      fileId,
      alt: 'media'
    });
    
    const newContent = existingContent.data + '\n' + logEntry;
    
    await drive.files.update({
      fileId,
      media: {
        mimeType: 'text/plain',
        body: newContent
      }
    });
  } else {
    // Create new log file
    const createResponse = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [process.env.VITE_GOOGLE_DRIVE_LOGS_FOLDER_ID],
        mimeType: 'text/plain'
      },
      media: {
        mimeType: 'text/plain',
        body: logEntry
      },
      fields: 'id'
    });
    
    fileId = createResponse.data.id;
  }
  
  return { fileId, fileName };
}
```

### User Interface Integration

#### New Components to Add

1. **DriveConnectionStatus.svelte**
   - Shows Google Drive connection status
   - "Connect to Google Drive" button if not connected
   - "Disconnect" option
   - Last sync timestamp
   - Available storage info

2. **ExportToDriveButton.svelte**
   - "Export to Drive" button on inventory page
   - Choose format: CSV or Google Sheet
   - Progress indicator during upload
   - Success message with link to file
   - Error handling and retry option

3. **DriveFileList.svelte**
   - List recent exports in Drive
   - Filter by type (CSV, Sheets, Logs)
   - Open in Drive button
   - Delete option
   - Download to local option

4. **LogViewer.svelte**
   - View logs from Drive
   - Filter by date range
   - Search functionality
   - Export selected logs

#### Routes to Add or Modify

1. **/drive** - Drive management dashboard
   - Connection status
   - Recent files
   - Storage usage
   - Settings (folder selection, auto-export preferences)

2. **/csv** - Enhance existing CSV export page
   - Keep existing preview functionality
   - Add "Save to Drive" button
   - Add "Create Google Sheet" button
   - Show recent exports from Drive

3. **/inventory** - Enhance inventory list
   - Add "Quick Export to Drive" action
   - Show last export timestamp
   - Schedule automatic exports option

4. **/auth/google/callback** - OAuth callback handler
   - Exchange authorization code for tokens
   - Store tokens securely
   - Redirect back to previous page

### Security Best Practices

#### Token Storage

**Client-Side (Browser):**
- Store access tokens in memory only (React/Svelte state)
- Store refresh tokens in secure HttpOnly cookies (if possible)
- Alternative: Encrypted storage in Firestore with user-specific encryption key
- Never store in localStorage (vulnerable to XSS)

**Server-Side (Firebase Functions):**
- Use Firebase Secret Manager
- Encrypt tokens before storing in Firestore
- Implement automatic token rotation

#### Access Control

1. **Firestore Security Rules** (for token storage):
   ```javascript
   match /userTokens/{userId} {
     allow read, write: if request.auth.uid == userId;
   }
   ```

2. **Scope Limitation**:
   - Request minimum necessary scopes
   - Use `drive.file` instead of `drive` when possible
   - Avoid `drive.appdata` unless specifically needed

3. **Error Handling**:
   - Don't expose sensitive error details to users
   - Log security events (failed auth, token refresh failures)
   - Implement rate limiting for API calls

#### Data Privacy

- **File Permissions**: All files created should only be accessible to dobustustationery@gmail.com
- **Audit Logging**: Track all Drive operations (create, update, delete) in Firestore
- **Data Encryption**: Consider encrypting sensitive data before uploading to Drive
- **Compliance**: Ensure GDPR/privacy compliance if customer data is exported

### Configuration Summary

#### Environment Variables to Add

```env
# Google Drive OAuth Configuration
VITE_GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_GOOGLE_DRIVE_CLIENT_SECRET=your-client-secret (backend only, not exposed to frontend)
VITE_GOOGLE_DRIVE_API_KEY=your-api-key (optional, for public data)
VITE_GOOGLE_DRIVE_REDIRECT_URI=http://localhost:5173/auth/google/callback

# Google Drive Folder IDs
VITE_GOOGLE_DRIVE_FOLDER_ID=main-folder-id
VITE_GOOGLE_DRIVE_INVENTORY_FOLDER_ID=inventory-subfolder-id
VITE_GOOGLE_DRIVE_ORDERS_FOLDER_ID=orders-subfolder-id
VITE_GOOGLE_DRIVE_LOGS_FOLDER_ID=logs-subfolder-id
VITE_GOOGLE_DRIVE_REPORTS_FOLDER_ID=reports-subfolder-id

# OAuth Scopes (comma-separated)
VITE_GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/spreadsheets

# Service Account (if using Option 2)
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

#### Firebase Console Configuration Steps

1. **Enable APIs** (one-time setup):
   - Google Cloud Console > APIs & Services > Library
   - Enable "Google Drive API"
   - Enable "Google Sheets API"

2. **Create OAuth Credentials** (one-time setup):
   - APIs & Services > Credentials > Create Credentials > OAuth client ID
   - Configure consent screen
   - Save Client ID and Client Secret

3. **Create Service Account** (optional, for Option 2):
   - IAM & Admin > Service Accounts > Create Service Account
   - Download JSON key
   - Share Drive folder with service account email

4. **Configure Firestore Security Rules** (for token storage):
   ```javascript
   match /databases/{database}/documents {
     match /userTokens/{userId} {
       allow read, write: if request.auth != null && request.auth.uid == userId;
     }
   }
   ```

#### Google Drive Setup Steps

1. **Create Main Folder**:
   - Log in to Google Drive as dobustustationery@gmail.com
   - Create folder: "Dobutsu Admin Exports"
   - Get folder ID from URL
   - Add to environment variables as `VITE_GOOGLE_DRIVE_FOLDER_ID`

2. **Create Subfolders**:
   - Inside main folder, create: Inventory, Orders, Logs, Reports
   - Get each folder ID
   - Add to environment variables

3. **Set Permissions**:
   - Main folder: Only dobustustationery@gmail.com (owner)
   - If using service account: Share with service account email (Editor)
   - Never make folders publicly accessible

### Migration and Rollout Plan

#### Phase 1: Basic Drive Integration
- Implement OAuth flow
- Token storage and management
- Basic file upload (CSV export)
- Connection status UI
- Manual export only

#### Phase 2: Enhanced Features
- Google Sheets creation
- File listing and management
- Log file creation and appending
- Scheduled/automatic exports

#### Phase 3: Advanced Features
- Collaborative editing alerts
- Real-time sync from Sheets back to Firestore
- Advanced formatting and templates
- Analytics dashboard from Drive data

### Error Handling and Edge Cases

#### Common Errors and Solutions

1. **Token Expiration (401 Unauthorized)**
   - Solution: Automatically refresh token using refresh token
   - Fallback: Prompt user to reconnect if refresh fails

2. **Rate Limiting (429 Too Many Requests)**
   - Solution: Implement exponential backoff
   - Queue requests and retry
   - Show user-friendly message about temporary delay

3. **Insufficient Permissions (403 Forbidden)**
   - Solution: Prompt user to re-authorize with correct scopes
   - Check folder permissions

4. **Network Errors**
   - Solution: Retry with exponential backoff
   - Cache data for offline access
   - Queue operations for later sync

5. **File Already Exists**
   - Solution: Append timestamp to filename
   - Or prompt user to overwrite/rename
   - Or use versioning system

6. **Folder Not Found**
   - Solution: Verify folder ID configuration
   - Create folder programmatically if allowed
   - Prompt admin to verify settings

#### Monitoring and Logging

- Log all API calls with timing information
- Track success/failure rates
- Monitor quota usage
- Alert on repeated failures
- User activity tracking for audit

### Testing Strategy

#### Unit Tests
- Token refresh logic
- CSV generation
- Sheet formatting
- Error handling

#### Integration Tests
- OAuth flow (using test accounts)
- File upload/download
- Sheet creation and updates
- Permission checks

#### E2E Tests
- Complete user flow: login → export → verify in Drive
- Error scenarios: network failure, expired token
- Multi-user scenarios

### Performance Considerations

#### Optimization Strategies

1. **Batch Operations**
   - Upload multiple files in parallel (with rate limit respect)
   - Batch sheet updates into single API call
   - Use batch APIs when available

2. **Caching**
   - Cache folder listings (refresh periodically)
   - Cache file metadata
   - Use ETags for conditional requests

3. **Lazy Loading**
   - Load Drive integration only when needed
   - Code-split googleapis library
   - Defer token refresh until necessary

4. **Progress Indication**
   - Show upload progress for large files
   - Indicate background sync status
   - Queue management visibility

### Alternatives and Trade-offs

#### Alternative 1: Firebase Cloud Functions + Drive

**Pros:**
- Keeps API keys server-side
- Better security
- Can handle larger files
- Background processing

**Cons:**
- Additional complexity
- Cold start latency
- Additional Firebase costs
- Requires Cloud Functions setup

#### Alternative 2: Direct REST API (No googleapis package)

**Pros:**
- Smaller bundle size
- More control over requests
- No dependency on googleapis package
- Easier to debug network issues

**Cons:**
- More manual implementation
- Need to handle OAuth flow manually
- Less type safety
- More maintenance burden

#### Alternative 3: Server-Side Only (Service Account)

**Pros:**
- No user authentication needed
- Simpler implementation
- More reliable
- Better for automated tasks

**Cons:**
- Can't access user-specific data
- No user context for audit logs
- Requires additional server infrastructure
- Less flexible for user-initiated exports

### Recommended Approach

**For Dobutsu Admin Application:**

1. **Use OAuth 2.0 User Authentication (Option 1)** for user-initiated actions:
   - CSV exports from UI
   - Manual sheet creation
   - File browsing

2. **Use Service Account (Option 2)** for automated/background tasks:
   - Scheduled nightly exports
   - Log aggregation
   - Automatic backups

3. **Hybrid Approach Benefits:**
   - User actions are auditable (who exported what)
   - Automated tasks are reliable (no user token expiration issues)
   - Best of both worlds

### Success Metrics

- Time saved on manual CSV downloads and email distribution
- Number of exports to Drive per week
- User adoption rate (% of admins using Drive integration)
- Error rate and resolution time
- User satisfaction scores

### Future Enhancements

1. **Google Photos Integration** (aligned with PRODUCT_IMPORT_DESIGN.md)
   - Photo-based inventory scanning
   - Automatic JAN code extraction
   - LLM-powered product descriptions

2. **Google Calendar Integration**
   - Schedule inventory reviews
   - Order fulfillment deadlines
   - Automatic reminder creation

3. **Google Forms Integration**
   - Customer feedback collection
   - Inventory requests from warehouse
   - Quality control checklists

4. **Advanced Analytics**
   - BigQuery integration for data warehouse
   - Looker Studio dashboards
   - Predictive inventory modeling

## Summary

This design provides a comprehensive approach to integrating Google Drive and Google Sheets into the Dobutsu Stationery admin application. The recommended hybrid approach uses OAuth 2.0 for user-initiated actions and service accounts for automated tasks, providing both flexibility and reliability. Key implementation steps include enabling Google APIs, configuring OAuth credentials, setting up folder structure, and implementing secure token management. The integration will streamline data export, logging, and collaborative reporting workflows while maintaining security and audit compliance.

## References

- Google Drive API Documentation: https://developers.google.com/drive/api/guides/about-sdk
- Google Sheets API Documentation: https://developers.google.com/sheets/api/guides/concepts
- OAuth 2.0 Guide: https://developers.google.com/identity/protocols/oauth2
- googleapis npm package: https://www.npmjs.com/package/googleapis
- Firebase Security Best Practices: https://firebase.google.com/docs/rules/best-practices
