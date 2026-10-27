# Repair photos for stocked items

Open **Photos → Repair imported photos**. Let saved data finish loading, then choose **Check stocked item photos**.

The main queue starts with items whose quantity minus shipped is positive. It checks their assigned photos and current saved gallery images, across all brands. It includes missing images. Import history is used only to help find an original.

- Previously approved replacements and photos you marked good are skipped.
- Current files at least 1024 pixels on the longest side stay out by default. Files below that size are flagged; an unreadable image gets **Needs a look** rather than being assumed good.
- **Other stocked photos** lets you flag an otherwise large photo that is blurry or unsuitable. **Photo is good** dismisses that file without import or processing. A new file or Shopify master version is checked independently.

Open a queue row with **Review**. If the current image is fine, choose **Photo is good — no repair needed**. Otherwise re-import, select an original in Google Photos, upload one, or choose a photo already in the system. Process it, crop it, or choose **Use original as candidate** when no processing is needed. Compare the result, then **Approve and update** or redo it.

Each candidate still needs individual approval. Repeated uses share a task. For a missing photo, approval fills the inventory image and adds its gallery image when a saved listing exists. Gallery order, variant assignments and existing IDs are preserved. Duplicate copies in a photo group are all updated; other edits of the same photo are left alone.

Previously detected entries that still match a stocked item's current photo remain in **Needs photos** even before a current measurement exists. Checking photos updates that assessment; it is not required to restore the detected queue after reload. Known good or repaired photos stay excluded.

**Saved work** shows every recorded repair entry, including discovery-only entries, original imports, attempts, Later decisions and completed replacements. Unused and zero-stock discovery entries no longer fill the main queue. No discovery history is deleted.

Progress survives reload. Reopen this screen to resume a processing step or approved update awaiting publication. Retry failed imports, processing or Shopify updates from their entry. A listing marked `no_sync` is updated locally only. Shopify still rebuilds the gallery when syncing; unapproved photos retain their current URLs.

The [design](../design/photo-import-repair-plan.md) records the data and event contracts. The [incident summary](../../PHOTO_IMPORT_BUG.md) links the original evidence.
