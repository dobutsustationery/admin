# Google Drive Integration for CSV Export - Setup Guide

## Overview

This implementation provides an MVP (Minimal Viable Product) for exporting inventory data directly to Google Drive. Users can authenticate with Google, enter a filename, and upload CSV files to a designated Drive folder.

## Features

- OAuth 2.0 authentication with Google Drive
- Direct CSV upload to configured Drive folder
- List recent exports in the Drive folder
- Filename customization before export
- Token management with automatic expiration handling
- CSV preview retained for convenience

## Setup Instructions

### 1. Enable Google Drive API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your Firebase project: `dobutsu-stationery-6b227`
3. Navigate to "APIs & Services" > "Library"
4. Search for and enable "Google Drive API"

### 2. Create OAuth 2.0 Credentials

1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "OAuth client ID"
3. Select application type: "Web application"
4. Configure:
   - **Name**: Dobutsu Admin - Drive Integration
   - **Authorized JavaScript origins**:
     - `http://localhost:5173` (development)
     - `https://admin.dobutsustationery.com` (production)
   - **Authorized redirect URIs**:
     - `http://localhost:5173/csv` (development)
     - `https://admin.dobutsustationery.com/csv` (production)
5. Save and copy the **Client ID**

### 3. Configure OAuth Consent Screen

1. Go to "APIs & Services" > "OAuth consent screen"
2. Set user type: "Internal" (if using Google Workspace) or "External"
3. Configure:
   - **Application name**: Dobutsu Stationery Admin
   - **User support email**: dobustustationery@gmail.com
   - **Developer contact**: dobustustationery@gmail.com
4. Add scopes:
   - `https://www.googleapis.com/auth/drive.file` (access to files created by the app)

### 4. Create Google Drive Folder

1. Log in to Google Drive as dobustustationery@gmail.com
2. Create a folder named "Dobutsu Admin Exports" (or your preferred name)
3. Open the folder and copy the **Folder ID** from the URL
   - URL format: `https://drive.google.com/drive/folders/FOLDER_ID_HERE`
   - Copy the `FOLDER_ID_HERE` part

### 5. Configure Environment Variables

Add the following to your environment files (`.env.local`, `.env.production`, etc.):

```env
# Google Drive Integration
VITE_GOOGLE_DRIVE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_GOOGLE_DRIVE_FOLDER_ID=your-folder-id-from-drive-url
VITE_GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file
```

Replace:
- `your-client-id.apps.googleusercontent.com` with your OAuth Client ID
- `your-folder-id-from-drive-url` with your Drive folder ID

## User Workflow

1. Navigate to `/csv` page
2. Click "Connect to Google Drive" button
3. Authenticate with Google account (dobustustationery@gmail.com)
4. Grant permission to access Drive
5. Return to CSV page (automatically authenticated)
6. Enter desired filename (defaults to `inventory-export-YYYY-MM-DD.csv`)
7. Click "Export to Drive"
8. File is uploaded to the configured Drive folder
9. View recent exports in the table below

## Security Considerations

- Access tokens are stored in browser localStorage
- Tokens automatically expire after 1 hour
- Token validation ensures structure integrity
- Expired tokens are automatically cleared
- OAuth scopes limited to `drive.file` (only files created by app)
- All network errors trigger token re-authentication

## Testing

### E2E Tests

Run the E2E test suite:

```bash
npm run test:e2e
```

The CSV export test validates:
- UI elements are present
- Google Drive section displays correctly
- Authentication flow works
- "Not configured" message shown when env vars missing

### Manual Testing

1. Set up environment variables as described above
2. Start dev server: `npm run dev`
3. Navigate to `http://localhost:5173/csv`
4. Test the complete OAuth flow and file upload

## Troubleshooting

### "Google Drive integration is not configured"

- Verify `VITE_GOOGLE_DRIVE_CLIENT_ID` and `VITE_GOOGLE_DRIVE_FOLDER_ID` are set
- Check that values are not the placeholder defaults
- Restart dev server after adding environment variables

### OAuth redirect fails

- Verify redirect URI matches exactly in Google Cloud Console
- Check that the domain is in "Authorized JavaScript origins"
- Ensure OAuth consent screen is properly configured

### Upload fails with 401 error

- Token has expired - click "Disconnect" and reconnect
- Verify OAuth scopes include `drive.file`
- Check that the folder ID is correct and accessible

### Upload fails with 403 error

- Check folder permissions in Google Drive
- Ensure dobustustationery@gmail.com owns the folder
- Verify OAuth consent screen has correct scopes

## Development Notes

### Token Management

Tokens are stored in localStorage with the key `google_drive_access_token`. The stored object includes:

```typescript
{
  access_token: string;
  expires_in: number;
  expires_at: number;  // Unix timestamp
  scope: string;
  token_type: string;
}
```

### API Calls

The implementation uses Google Drive REST API v3:

- **List files**: `GET /drive/v3/files`
- **Upload file**: `POST /upload/drive/v3/files?uploadType=multipart`

### Error Handling

All API errors are caught and displayed to the user. Common errors:

- **401 Unauthorized**: Token expired (automatically clears token)
- **403 Forbidden**: Insufficient permissions
- **404 Not Found**: Folder doesn't exist
- **Network errors**: Connectivity issues

## Future Enhancements

- Refresh token support for long-lived sessions
- Automatic retry with exponential backoff
- Google Sheets export option
- Scheduled/automatic exports
- Multiple folder support
- File versioning

## References

- [Google Drive API Documentation](https://developers.google.com/drive/api/guides/about-sdk)
- [OAuth 2.0 for Client-side Web Apps](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)
- [Google Drive REST API v3](https://developers.google.com/drive/api/v3/reference)
