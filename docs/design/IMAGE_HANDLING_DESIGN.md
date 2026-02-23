# Image Handling Design

## 1. Introduction

The current approach to image handling in the application suffers from several significant issues:
*   **Performance Bottlenecks:** We are frequently loading full-size images (using `=s0` or raw URLs) across all views. This consumes massive amounts of bandwidth, slows down page rendering, and frequently bogs down the browser or causes out-of-memory (OOM) errors.
*   **Inefficient Data Transfers:** When promoting an image from Google Photos to Google Drive, the client browser downloads the full image blob from Photos and then uploads it back to Google Drive. This wastes client bandwidth and is fragile on slower connections.
*   **State Bloat:** There is a risk of image data (Base64 strings or raw Blobs) ending up in our broadcast actions or Redux state, which violates our event sourcing architecture and cripples the broadcast log.

This document outlines the new architectural standards for image handling to resolve these issues, focusing on performance, robust state management, and efficient cloud-to-cloud transfers.

## 2. Core Principles

1.  **Single Choke Point (`SecureImage`):** Absolutely all image rendering in the application MUST go through the `SecureImage` component. Direct use of `<img>` tags for dynamic user content is prohibited. This ensures a single place to enforce authentication, sizing policies, and loading strategies.
2.  **References Only, Never Blobs:** Redux state and Broadcast Actions must NEVER contain image Blobs, `data:` URIs, or Base64 encoded strings. They must only contain stable URLs (e.g., Google Drive `lh3.googleusercontent.com` public URLs) or IDs. 
3.  **Cloud-to-Cloud Transfers:** Transferring images between Google services (e.g., Photos to Drive) must happen backend-to-backend whenever possible, bypassing the client completely.

## 3. Dynamic Quality & Progressive Loading (`SecureImage`)

To dramatically speed up loading without compromising the user experience when high quality is expected, `SecureImage` will act as a smart proxy for image URLs.

### URL Sizing Parameters
Google Drive and Google Photos image URLs (typically `lh3.googleusercontent.com/...`) support powerful sizing parameters appended to the URL path (e.g., `=s200`, `=w400-h400-c`, `=s0`). 

Currently, our state often hardcodes `=s0` (original size) on the URLs. `SecureImage` will strip any existing sizing parameters and apply context-appropriate ones dynamically based on a new `size` prop.

### The `size` Prop
`SecureImage` will accept a `size` prop with standard values:
*   `thumbnail` (e.g., `=s200-c`): Used in grids, tables, and lists. Dramatically reduces payload size.
*   `preview` (e.g., `=s800`): Used for standard display sizes, sidebars, or split views.
*   `full` (e.g., `=s0`): Used for zoomed views, full-screen overlays, and anywhere the user explicitly expects to see the maximum detail.

### Progressive Enhancement (Blur-Up / Low-to-High)
When `size="full"` is requested, `SecureImage` should implement a progressive loading strategy:
1.  Immediately load the `thumbnail` (or `preview`) size. Because these are used elsewhere in the app, they are likely already in the browser cache and will render instantly.
2.  In the background, request the `full` size image.
3.  Once the `full` size image is fully downloaded, seamlessly swap it in. 

This guarantees the user never sees a broken or slowly painting image when they open a modal, while still eventually providing the full-quality preview they expect.

## 4. State and Action Persistence (Strict Ban on Blobs)

*   **Broadcast Actions:** Actions dispatched to the `broadcast` middleware are permanent. Storing a 5MB Base64 string in a single action will bloat the Firestore document and the local database. Any action containing `data:image/...` or Blob references will be rejected.
*   **Temporary Client State (Cropping/Editing):** If the user performs a local action like manual cropping that generates a Blob, that Blob can exist in ephemeral component state. However, before that edit can be "saved" or broadcast, the client MUST upload the Blob to a durable storage location (Google Drive) and dispatch the resulting public URL.

## 5. Server-to-Server Image Transfers (Event-Driven via Sync Queue)

Currently, `uploadImageToDrive` in `src/lib/google-drive.ts` handles Photos-to-Drive promotion by fetching the image into a client-side Blob and then issuing a PUT request to Drive. This is extremely inefficient for bulk operations and prone to failures.

**New Architecture: Event-Driven Transfer via `sync` Queue**
Instead of the client acting as a middleman or calling a synchronous HTTP endpoint, we will leverage our existing robust background job architecture. 

*Implementation Note:* We will rename the existing `shopify_sync` Firestore collection and its corresponding Cloud Function trigger to simply `sync`. This refactoring broadens the path for general reuse. To keep the sync log readable and allow the Cloud Function to easily route tasks, all events in this collection will use namespaced `eventType`s (e.g., `shopify/sync_requested`, `photos/image_transfer_requested`).

1.  **Client Intent:** To initiate a transfer, the client writes a new document to the `sync` collection with a specific event type (e.g., `eventType: "photos/image_transfer_requested"`). This document contains the source Google Photos URL/ID, target context, and a unique `requestId`.
2.  **In-Flight State Tracking:** Because the request is recorded in the `sync` collection (and synced to local state via Redux, similarly to Shopify sync statuses), the client knows the transfer is "in-flight". If the user reloads the page, the client recovers this state and avoids duplicate transfer requests.
3.  **Backend Processing:** The existing Cloud Function trigger (listening on `sync/{requestId}`) picks up the document. It splits the `eventType` on `/` to dispatch to the correct domain logic. For `photos/image_transfer_requested`, it delegates to a specialized worker. The worker streams the image directly from Google Photos and pipes it into the Google Drive upload API within Google's network, consuming zero client bandwidth.
4.  **Backend Status Actions:** As the worker processes the transfer, it appends response event documents back into the `sync` collection with the same `requestId`:
    *   `photos/image_transfer_started`: (Optional) Indicates the worker picked it up.
    *   `photos/image_transfer_completed`: Contains the newly created stable Google Drive public URL.
    *   `photos/image_transfer_failed`: Contains error details, allowing the client to show a failure state and offer a retry.
5.  **Client Resolution:** The client listens to the `sync` collection. When it receives the `photos/image_transfer_completed` event, it dispatches a "Green" action to the main `broadcast` log (e.g., `update_variant_image`) to permanently update the application state with the new, stable Drive URL, and clears its local loading indicator.

This approach guarantees state consistency across reloads, eliminates OOM crashes, and allows us to test and perfect the cloud functions logic independently (e.g., via CLI scripts) before relying on it live in the browser, exactly mirroring the proven backend sync workflow.
