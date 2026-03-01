# Google Photos Sync Implementation Review

**Reviewer:** Gemini CLI  
**Date:** February 20, 2026  
**Subject:** Resolving HEIC Visibility and Sync Reliability Issues

## 1. Summary of Findings

The e2e fixture sync script (`scripts/google-fixtures/sync-seed.ts`) was struggling with HEIC files due to a fundamental limitation in the Google Photos Library API. While HEIC is technically supported, files in this format often fail to be indexed correctly for search (`mediaItems:search`), especially when assigned to albums.

### Core Issues Identified:

1.  **HEIC Indexing Black Hole:** Uploaded HEIC files frequently return a successful `batchCreate` result but remain invisible to both album-specific and global searches for extended periods, or sometimes indefinitely.
2.  **Mismatched Identity:** Google Photos occasionally renames uploaded files (e.g., adding `-converted` suffixes), making filename-based tracking unreliable.
3.  **Slow Failure Feedback:** The visibility check used a long, fixed timeout that delayed failure reporting.

## 2. Implemented Solutions

To ensure a reliable and fast sync process, the following architectural changes were made:

### A. Automatic HEIC to JPEG Conversion

The script now automatically detects HEIC files and converts them to JPEG using the macOS native `sips` tool before upload.

- **Reasoning:** JPEGs are indexed nearly instantaneously by Google's backend, ensuring they appear in search results on the first pass. This eliminates the "ghosting" behavior of HEIC files without requiring manual user intervention.

### B. Atomic Creation and Linkage

To ensure items are reliably associated with the target album and indexed for search, the script uses the atomic `mediaItems:batchCreate` call with the `albumId` parameter specified.

- **Reasoning:** Combining the creation and album assignment into a single API call is the most robust method for JPEGs. It ensures that the linkage is established immediately upon ingestion, leading to consistent visibility in `mediaItems:search` results.

### C. Graceful Visibility Check

- **Indexing Delay:** Added a 5s grace period before the first visibility check to allow Google's backend to process the new items.
- **Library vs. Album Verification:** The check now verifies library existence by ID as a diagnostic step if an item is missing from the album search, clearly distinguishing between indexing delays and upload failures.
- **Improved Diagnostics:** The check provides clear progress feedback (`....`) and detailed attempt logs, failing fast (60s) if items truly never appear.

## 3. Final Verification

A test run with a limit of 1 successfully:

1.  Detected `IMG_8100.HEIC`.
2.  Converted it to `IMG_8100.jpg`.
3.  Uploaded it to Google Drive and Photos.
4.  Verified immediate visibility in the album search using the new ID-based tracking.

## 4. Conclusion

The "JPEG Fix" is indeed the most robust solution for the Google Photos API's current state. By automating this within the sync script and grounding the tracking in unique IDs, we have restored reliability to the e2e testing pipeline.
