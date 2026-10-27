# Repair photos for stocked listings

Open **Photos → Repair imported photos**. The first step is **Select originals**. Existing detections are grouped by capture date with filenames and reference thumbnails.

Choose a date, copy it for Google Photos search, and choose **Select originals in Google Photos**. Select that day’s photos together; extra selections are fine. The app matches persistent Google photo IDs to current repair sources and immediately requests imports of matching originals. Extra photos are ignored, and sources already imported or importing are not imported again. Failed originals can be selected again.

After matching, the screen moves to **Process and review**. Imports may still be running. Use each photo’s Review button to process, inspect, approve or redo as before. Originals and attempts are saved in the event log; the selected screen and open repair are remembered in this browser tab across reloads. You can switch back to Select originals for another capture date. Its **Imported originals — continue your repairs** section groups saved originals by listing, with filenames, dates and Resume buttons. Imported photos leave the missing-originals list but remain available here until repaired or marked good.

Use **Check stocked item photos** to discover additional problems. Old detection results do not need to be scanned again to appear. There is no automatic re-import from old Google Photos links; expired selections require a fresh picker selection.

The main queue starts with saved listings containing items whose quantity minus shipped is positive. It checks their variant photos and current saved gallery images, across all brands, and includes missing images. Inventory items without a saved listing and standalone library photos are excluded. Import history is used only to help find an original.

Each table has one row per listing. Photos appear together as thumbnails with hover previews; use the Review button beside an individual photo to work on it. Listing stock is counted once, regardless of its number of photos.

- Previously approved replacements and photos you marked good are skipped.
- Current files at least 1024 pixels on the longest side stay out by default. Files below that size are flagged; an unreadable image gets **Needs a look** rather than being assumed good.
- **Other stocked photos** lets you flag an otherwise large photo that is blurry or unsuitable. **Photo is good** dismisses that file without import or processing. A new file or Shopify master version is checked independently.

Open a queue row with **Review**. If the current image is fine, choose **Photo is good — no repair needed**. Otherwise choose one original in Google Photos for this repair, upload an individual original, or choose a photo already in the system. Process it, crop it, or choose **Use original as candidate** when no processing is needed. Compare the result, then **Approve and update** or redo it. Hover over Current image, New original or New candidate for a larger preview. Dimensions beneath each image are measured from its loaded full-size file, not copied from original metadata or the temporary display preview.

Each candidate still needs individual approval. Repeated uses share a task. For a missing photo, approval fills the inventory image and adds its gallery image when a saved listing exists. Gallery order, variant assignments and existing IDs are preserved. Duplicate copies in a photo group are all updated; other edits of the same photo are left alone.

Previously detected entries that still match a stocked item's current photo remain in **Needs photos** even before a current measurement exists. Checking photos updates that assessment; it is not required to restore the detected queue after reload. Known good or repaired photos stay excluded.

**Saved work** groups recorded repair entries belonging to saved listings, including discovery-only entries, original imports, attempts, Later decisions and completed replacements. Unused and zero-stock discovery entries no longer fill the main queue. Standalone entries are hidden; no discovery history is deleted.

Progress survives reload. Reopen this screen to resume a processing step or approved update awaiting publication. The per-photo **Choose one original in Google Photos** action limits selection to one photo and assigns it directly to that repair. Unmatched batch selections are not shown as a gallery. For a failed original import, select the photo again; retry processing or Shopify updates from their entry. A listing marked `no_sync` is updated locally only. Shopify still rebuilds the gallery when syncing; unapproved photos retain their current URLs.

The [design](../design/photo-import-repair-plan.md) records the data and event contracts. The [incident summary](../../PHOTO_IMPORT_BUG.md) links the original evidence.
