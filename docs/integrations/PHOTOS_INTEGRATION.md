# Google Photos Integration - Design Document

## Overview

This document specifies the technical implementation details for integrating **Google Photos Picker API** into the Dobutsu Stationery product import workflow. It describes how to securely select product photos from a user's Google Photos library using the picker session flow.

## Background

The previous integration used the Google Photos Library API to access shared albums. However, due to scope deprecation in March 2025, that approach is no longer supported. The new implementation uses the **Google Photos Picker API**, which offers better privacy and security by allowing users to select specific photos to share with the application.

## Google Photos Picker API Overview

### API Service
- **Name**: Google Photos Picker API
- **Version**: v1
- **Documentation**: https://developers.google.com/photos
- **Base URL**: `https://photoslibrary.googleapis.com/v1`

### Key Capabilities
- Access to user's photo library and shared albums
- Retrieve media items (photos and videos) with metadata
- Search and filter media items by album
- Download photos at various resolutions
- Chronological ordering of media items

## Authentication and Authorization

### OAuth 2.0 Setup

The Google Photos API requires OAuth 2.0 for authentication. The application must be configured to access photos on behalf of the `dobutsustationery@gmail.com` account.

#### Required Steps

1. **Create Google Cloud Project**
   - Navigate to Google Cloud Console (https://console.cloud.google.com)
   - Create a new project or use existing project for Dobutsu Stationery
   - Note the Project ID for configuration

2. **Enable Google Photos Library API**
   - In the Google Cloud Console, navigate to "APIs & Services" > "Library"
   - Search for "Photos Library API"
   - Click "Enable" to activate the API for the project

3. **Configure OAuth Consent Screen**
   - Navigate to "APIs & Services" > "OAuth consent screen"
   - Choose "Internal" if using Google Workspace, or "External" for standard Gmail
   - Fill in application details:
     - Application name: "Dobutsu Stationery Admin"
     - User support email: dobutsustationery@gmail.com
     - Developer contact: dobutsustationery@gmail.com
   - Add required scopes (see below)
   - Save configuration

4. **Create OAuth 2.0 Credentials**
   - Navigate to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: "Web application"
   - Authorized JavaScript origins:
     - `http://localhost:5173` (for development)
     - `https://admin.dobutsustationery.com` (for production)
   - Authorized redirect URIs:
     - `http://localhost:5173/photos` (for development)
     - `https://admin.dobutsustationery.com/photos` (for production)
   - Save and download the client ID and client secret

### Required OAuth Scopes

The application needs the following OAuth 2.0 scopes:

- **`https://www.googleapis.com/auth/photoslibrary.readonly`**
  - Provides read-only access to the user's Google Photos library
  - Allows retrieval of albums and media items
  - Does not permit modifications to the library

- **`https://www.googleapis.com/auth/photoslibrary.sharing`** (optional)
  - Allows access to shared albums and sharing features
  - May be needed depending on album sharing configuration
  - Use if albums are explicitly shared rather than owned by the service account

### Service Account Alternative

For server-to-server access without user interaction:

1. **Create Service Account**
   - Navigate to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service account"
   - Provide service account details
   - Grant necessary roles (e.g., "Service Account User")
   - Download JSON key file

2. **Share Albums with Service Account**
   - Share the designated Google Photos albums with the service account email
   - Service account can then access shared albums programmatically

**Note**: Service accounts have limited support for Google Photos API. OAuth 2.0 with user consent is the recommended approach.

### Authentication Flow

For web applications using OAuth 2.0:

1. **User Authorization**
   - Redirect user to Google's OAuth 2.0 authorization endpoint
   - User grants permission for the requested scopes
   - Google redirects back to the application with an authorization code

2. **Token Exchange**
   - Exchange authorization code for access token and refresh token
   - Store refresh token securely for long-term access
   - Access tokens expire after 1 hour

3. **Token Refresh**
   - Use refresh token to obtain new access tokens when they expire
   - Implement automatic token refresh before API calls

## Shared Album Access

### Album Identification

Shared Google Photos albums can be identified in two ways:

1. **Share Token from URL**
   - Example URL: `https://photos.google.com/share/AF1QipP9FJxjPvZ7Ji0k6W8qCLIGJS3I1XgstsX7qFvjGAhZHwq_R0JOipXDW-z9_S21hQ`
   - The share token is the part after `/share/`: `AF1QipP9FJxjPvZ7Ji0k6W8qCLIGJS3I1XgstsX7qFvjGAhZHwq_R0JOipXDW-z9_S21hQ`
   - This token can be used to access the album via API

2. **Album ID**
   - Unique identifier assigned by Google Photos
   - Retrieved by listing albums or joining a shared album

### Accessing Shared Albums

**Method 1: Join Shared Album (Recommended)**

When a user has access to a shared album URL:

```http
POST https://photoslibrary.googleapis.com/v1/sharedAlbums:join
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{
  "shareToken": "AF1QipP9FJxjPvZ7Ji0k6W8qCLIGJS3I1XgstsX7qFvjGAhZHwq_R0JOipXDW-z9_S21hQ"
}
```

Response:
```json
{
  "album": {
    "id": "ALBUM_ID",
    "title": "New Inventory - December 2025",
    "productUrl": "https://photos.google.com/...",
    "mediaItemsCount": "42",
    "shareInfo": {
      "sharedAlbumOptions": {
        "isCollaborative": true,
        "isCommentable": false
      },
      "shareableUrl": "https://photos.google.com/share/...",
      "shareToken": "AF1QipP9..."
    }
  }
}
```

**Method 2: List Shared Albums**

Retrieve all albums shared with the authenticated user:

```http
GET https://photoslibrary.googleapis.com/v1/sharedAlbums
Authorization: Bearer ACCESS_TOKEN
```

Response includes array of shared albums with IDs and metadata.

## Retrieving Photos from Album

### List Media Items in Album

Once you have the album ID, retrieve photos in chronological order:

```http
POST https://photoslibrary.googleapis.com/v1/mediaItems:search
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json

{
  "albumId": "ALBUM_ID",
  "pageSize": 100,
  "orderBy": "MediaMetadata.creation_time"
}
```

**Request Parameters:**
- `albumId`: ID of the album to retrieve photos from
- `pageSize`: Number of items to return (1-100, default 25)
- `orderBy`: Sort order - use `"MediaMetadata.creation_time"` for chronological order
- `pageToken`: Token for pagination (from previous response)

**Response:**
```json
{
  "mediaItems": [
    {
      "id": "MEDIA_ITEM_ID_1",
      "productUrl": "https://photos.google.com/lr/photo/...",
      "baseUrl": "https://lh3.googleusercontent.com/...",
      "mimeType": "image/jpeg",
      "mediaMetadata": {
        "creationTime": "2025-12-01T10:23:45Z",
        "width": "4032",
        "height": "3024",
        "photo": {
          "cameraMake": "Apple",
          "cameraModel": "iPhone 13",
          "focalLength": 4.2,
          "apertureFNumber": 1.8
        }
      },
      "filename": "IMG_1234.jpg"
    },
    {
      "id": "MEDIA_ITEM_ID_2",
      "baseUrl": "https://lh3.googleusercontent.com/...",
      "mimeType": "image/jpeg",
      "mediaMetadata": {
        "creationTime": "2025-12-01T10:24:12Z",
        "width": "4032",
        "height": "3024"
      },
      "filename": "IMG_1235.jpg"
    }
  ],
  "nextPageToken": "CAoSB..."
}
```

### Pagination

The API returns results in pages. To retrieve all photos:

1. Make initial request without `pageToken`
2. If response includes `nextPageToken`, make another request with that token
3. Repeat until no `nextPageToken` is returned

**Example Pagination Flow:**
```
Request 1: { albumId: "...", pageSize: 100 }
Response 1: { mediaItems: [...], nextPageToken: "TOKEN_1" }

Request 2: { albumId: "...", pageSize: 100, pageToken: "TOKEN_1" }
Response 2: { mediaItems: [...], nextPageToken: "TOKEN_2" }

Request 3: { albumId: "...", pageSize: 100, pageToken: "TOKEN_2" }
Response 3: { mediaItems: [...] }  // No nextPageToken = last page
```

### Downloading Photos

The `baseUrl` in the response is a temporary URL that can be modified to download the photo at various sizes:

**URL Format:**
```
{baseUrl}=w{WIDTH}-h{HEIGHT}
```

**Examples:**
- Original size: `{baseUrl}=d` (download original)
- Specific dimensions: `{baseUrl}=w2048-h2048` (max 2048px on longest side)
- Thumbnail: `{baseUrl}=w500-h500`

**Important Notes:**
- `baseUrl` is temporary and expires after 60 minutes
- Always fetch fresh URLs from the API before downloading
- URLs cannot be stored for later use

**Download Example:**
```http
GET https://lh3.googleusercontent.com/lr/ENCODED_DATA=d
```

This returns the raw image data (JPEG, PNG, etc.)

## API Rate Limits and Quotas

### Google Photos API Quotas

- **Queries per day**: 10,000 (default)
- **Queries per 100 seconds**: 1,000
- **Queries per 100 seconds per user**: 100

### Best Practices

1. **Implement Exponential Backoff**
   - Retry failed requests with increasing delays
   - Handle 429 (Too Many Requests) errors gracefully

2. **Batch Processing**
   - Process photos in batches rather than one at a time
   - Use pageSize of 100 to minimize API calls

3. **Caching**
   - Cache album metadata and media item lists
   - Refresh only when new photos are detected
   - Store media item IDs to detect new additions

4. **Polling Strategy**
   - Poll for new photos periodically (e.g., every 5-10 minutes)
   - Use mediaItemsCount to detect changes before fetching
   - Implement webhook if available (check API docs for updates)

## Implementation Architecture

### High-Level Flow

```
1. User Authentication
   └─> OAuth 2.0 flow with dobutsustationery@gmail.com
   └─> Store access and refresh tokens securely

2. Album Configuration
   └─> Join shared album using share token
   └─> Store album ID for future requests

3. Photo Retrieval
   └─> Poll album for new photos periodically
   └─> Retrieve photos in chronological order
   └─> Download photos using baseUrl + parameters

4. Photo Processing
   └─> Group photos by JAN barcode detection
   └─> Pass to LLM for analysis and description generation
   └─> Create inventory receipt entries

5. State Tracking
   └─> Track last processed photo timestamp
   └─> Detect new photos since last check
   └─> Handle duplicates and retries
```

### Configuration Requirements

**Environment Variables:**
```bash
# Google Cloud Project
GOOGLE_CLOUD_PROJECT_ID=dobutsu-stationery-admin

# OAuth 2.0 Credentials
GOOGLE_PHOTOS_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_PHOTOS_CLIENT_SECRET=xxxxx
GOOGLE_PHOTOS_REDIRECT_URI=https://admin.dobutsustationery.com/auth/callback

# Album Configuration
GOOGLE_PHOTOS_ALBUM_SHARE_TOKEN=AF1QipP9FJxjPvZ7Ji0k6W8qCLIGJS3I1XgstsX7qFvjGAhZHwq_R0JOipXDW-z9_S21hQ
GOOGLE_PHOTOS_ALBUM_ID=  # Set after joining album

# Processing Configuration
PHOTO_POLL_INTERVAL_MINUTES=10
PHOTO_BATCH_SIZE=100
```

**Firestore Collections:**
```
/photos_integration/
  /config/
    album_id: string
    last_sync_time: timestamp
    share_token: string
  
  /processed_photos/
    {media_item_id}/
      processed_at: timestamp
      jan_code: string
      product_group: string
      download_url: string (temporary)
      metadata: object

  /oauth_tokens/
    access_token: string (encrypted)
    refresh_token: string (encrypted)
    expires_at: timestamp
```

### Error Handling

**Common Errors and Responses:**

1. **401 Unauthorized**
   - Cause: Invalid or expired access token
   - Solution: Refresh access token using refresh token

2. **403 Forbidden**
   - Cause: Insufficient permissions or scope
   - Solution: Re-authenticate with correct scopes

3. **404 Not Found**
   - Cause: Album ID is invalid or album was deleted
   - Solution: Re-join album using share token

4. **429 Too Many Requests**
   - Cause: Rate limit exceeded
   - Solution: Implement exponential backoff, wait and retry

5. **500 Internal Server Error**
   - Cause: Google API temporary issue
   - Solution: Retry with exponential backoff

## Security and Privacy Considerations

### Data Protection

1. **Token Storage**
   - Store OAuth tokens encrypted in Firestore
   - Use Firebase Security Rules to restrict access
   - Never expose tokens in client-side code or logs

2. **Access Control**
   - Limit API access to authenticated admin users only
   - Use Firebase Authentication to verify user identity
   - Implement role-based access control (RBAC)

3. **Photo URLs**
   - baseUrl is temporary (60 minutes) - cannot be stored long-term
   - Download and store photos in Firebase Storage if persistence needed
   - Ensure proper access controls on stored photos

### Privacy Compliance

1. **User Consent**
   - Clearly communicate why Google Photos access is needed
   - Display OAuth consent screen with requested scopes
   - Allow users to revoke access at any time

2. **Data Minimization**
   - Only request necessary OAuth scopes
   - Only download photos from designated albums
   - Delete processed photos if no longer needed

3. **Audit Logging**
   - Log all API access and photo downloads
   - Track which photos were processed and when
   - Maintain audit trail for compliance

## Integration with Product Import Workflow

### Photo Processing Pipeline

Based on [PRODUCT_IMPORT_DESIGN.md](PRODUCT_IMPORT_DESIGN.md), the integration follows this pipeline:

```
1. Photo Retrieval (This Document)
   └─> Authenticate with Google Photos API
   └─> Join shared album
   └─> Retrieve photos in chronological order
   └─> Download photos at appropriate resolution

2. Barcode Detection
   └─> Scan each photo for JAN barcode
   └─> Identify photos containing barcodes
   └─> Mark as product boundary

3. Photo Grouping
   └─> Group consecutive photos by most recent barcode
   └─> First photo in group = JAN barcode
   └─> Subsequent photos = product details

4. LLM Analysis (Separate Component)
   └─> Extract JAN code from barcode photo
   └─> Analyze detail photos for product features
   └─> Generate product description

5. Inventory Receipt (Separate Component)
   └─> Create receipt entry with extracted data
   └─> Present to user for classification
   └─> Merge, subtype, or create new listing
```

### Recommended Photo Download Strategy

For LLM processing, download photos at medium resolution to balance quality and cost:

- **Barcode Photos**: `w1024-h1024` (sufficient for OCR)
- **Detail Photos**: `w2048-h2048` (good quality for visual analysis)
- **Original**: Only if needed for archival purposes

### Detecting New Photos

To avoid reprocessing photos, track the last processed photo:

```typescript
interface ProcessingState {
  lastProcessedTime: Date;        // Creation time of last photo processed
  lastProcessedMediaItemId: string; // ID of last photo processed
  albumMediaItemsCount: number;   // Last known count of photos in album
}
```

**Detection Logic:**
1. Fetch album metadata to check `mediaItemsCount`
2. If count increased, fetch new photos since `lastProcessedTime`
3. Process new photos in chronological order
4. Update `lastProcessedTime` after successful processing

## Testing and Development

### Development Setup

1. **Use Separate Google Account**
   - Create test Google account for development
   - Create test photo albums with sample products
   - Avoid using production data during development

2. **Sample Data**
   - Create album with mock product photos
   - Include photos with JAN barcodes and detail shots
   - Test with various photo qualities and formats

3. **API Playground**
   - Use OAuth 2.0 Playground (https://developers.google.com/oauthplayground)
   - Test API endpoints before implementation
   - Verify responses and error handling

### Testing Checklist

- [ ] OAuth 2.0 flow completes successfully
- [ ] Can join shared album using share token
- [ ] Can retrieve photos in chronological order
- [ ] Pagination works for albums with >100 photos
- [ ] Photos download correctly at various resolutions
- [ ] Token refresh works when access token expires
- [ ] Rate limiting is handled gracefully
- [ ] Error cases (404, 403, 429, 500) are handled
- [ ] New photos are detected correctly
- [ ] No duplicate processing of same photos

## API Client Libraries

Google provides official client libraries for various languages:

### Node.js (Recommended for SvelteKit)
```bash
npm install googleapis
```

**Example Usage:**
```javascript
const { google } = require('googleapis');

// Initialize OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Set credentials
oauth2Client.setCredentials({
  access_token: ACCESS_TOKEN,
  refresh_token: REFRESH_TOKEN
});

// Initialize Photos Library API
const photosLibrary = google.photoslibrary({
  version: 'v1',
  auth: oauth2Client
});

// Join shared album
const album = await photosLibrary.sharedAlbums.join({
  requestBody: {
    shareToken: SHARE_TOKEN
  }
});

// List media items
const response = await photosLibrary.mediaItems.search({
  requestBody: {
    albumId: album.data.album.id,
    pageSize: 100,
    orderBy: 'MediaMetadata.creation_time'
  }
});
```

### Python (Alternative)
```bash
pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client
```

## Migration and Deployment

### Deployment Steps

1. **Pre-Deployment**
   - Set up Google Cloud Project
   - Enable Google Photos Library API
   - Create OAuth 2.0 credentials
   - Configure environment variables

2. **Initial Setup**
   - Deploy authentication flow
   - Complete OAuth consent as dobutsustationery@gmail.com
   - Join shared album and store album ID

3. **Gradual Rollout**
   - Start with manual trigger for photo processing
   - Monitor API usage and quotas
   - Test with small batches before full automation

4. **Monitoring**
   - Track API call volume and quotas
   - Monitor error rates
   - Set up alerts for authentication failures

### Rollback Plan

If issues occur:
1. Disable automatic photo polling
2. Revert to manual product entry
3. Investigate and fix issues
4. Re-enable with manual testing first

## Future Enhancements

### Potential Improvements

1. **Webhook Support**
   - Monitor Google Photos API for webhook support
   - Replace polling with push notifications
   - Reduce API calls and improve responsiveness

2. **Incremental Sync**
   - Track individual photo processing status
   - Support resuming interrupted processing
   - Handle partial failures gracefully

3. **Multiple Albums**
   - Support processing from multiple albums
   - Different albums for different suppliers
   - Parallel processing of multiple albums

4. **Advanced Filtering**
   - Filter photos by date range
   - Exclude certain photos from processing
   - Support manual photo selection

5. **Photo Storage**
   - Archive processed photos to Firebase Storage
   - Maintain permanent URLs for inventory records
   - Implement cleanup policy for old photos

## Summary

This design document specifies the Google Photos API integration required to implement the photo-based product import workflow described in PRODUCT_IMPORT_DESIGN.md. The integration provides:

- **Secure Authentication**: OAuth 2.0 flow with proper scope management
- **Shared Album Access**: Join and retrieve photos from shared albums
- **Chronological Retrieval**: Fetch photos in creation time order for sequential processing
- **Reliable Downloads**: Handle temporary URLs and photo resolution options
- **Scalable Architecture**: Pagination, rate limiting, and error handling
- **Privacy and Security**: Encrypted token storage and audit logging

By following this design, the Dobutsu Stationery admin application can automatically retrieve photos from Google Photos shared albums, process them in sequence to detect JAN barcodes and group product images, and feed them into the LLM-based product description workflow.
