# Repair imported photos

Open **Photos → Repair imported photos** (also under Tools).

1. Choose **Find affected photos** to build the queue from bad-path import records and the October 26 audit. Stocked products appear first. **Include other small images** also adds images whose origin is uncertain.
2. Open a row with **Review**. Try **Re-import original**, or select originals in Google Photos / upload an original from your computer. When several selected photos are returned, choose the appropriate source for each queue entry.
3. Choose processing steps and order, then **Process original**. You can process selected entries together. All results still need individual review.
4. Compare the current image, new original and new candidate. Use **Redo processing**, **Crop manually** or choose a different original until the result is right. Start from the original or a completed processing step.
5. Choose **Approve and update** for that candidate. This updates the displayed local uses and queues their Shopify listings. Each candidate requires its own approval.

Progress survives reload. Reopen this screen to resume the next processing step or an approved update awaiting publication. A failed import offers reselection/upload; a failed processing step offers Retry or Redo; a failed Shopify update offers **Retry Shopify update**. A listing marked `no_sync` is updated locally only.

The Shopify sync currently rebuilds the product gallery. Local photo IDs, image order and variant assignments are retained; Shopify assigns new media IDs. Images not yet approved continue using their current URLs.

The [design](../design/photo-import-repair-plan.md) records the IDs, data structures and events. The [incident summary](../../PHOTO_IMPORT_BUG.md) links the original evidence.
