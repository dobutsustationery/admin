# Photo import repair plan

Fix the downloader, re-import photos that went through the broken path, and give the user a queue to review every replacement. Each photo is processed with the existing tools. Nothing is replaced until the user approves its new candidate.

## Fix the bug

Remove the bare Google Photos URL from the source download candidates. Download using `=d`; if that fails, show the import failure and let the user retry or select the original again. Do not fall back to a preview.

A re-import must fetch a fresh source instead of returning the old cached Drive copy. Redoing processing must actually run it again instead of returning the previous cached result. Make those two actions work in both browser and server paths.

## Open the repair queue

Add a **Repair imported photos** screen linked from Photos. Populate it from recorded imports through the bad path and their product associations, using the existing audit as a starting point. Include photos even if a later edit produced a larger file. Group repeated uses of the same source so the user does not need to import it repeatedly.

Show the product name, JAN, current image and progress for each entry. Put stocked products first. Provide filters for **Needs original**, **Processing**, **Needs review** and **Done**. Keep progress when the user leaves and returns.

Small images with no known bad-path import can appear under **Other small images** for the same manual workflow. They do not need to block work on the known affected imports.

## Get the correct originals into the system

The user selects entries and chooses **Re-import originals**. Fetch the originals where access still works. For anything that cannot be fetched, show **Select original in Google Photos** and the old image and filename to help the user find it. Also allow **Upload original** from the computer.

When choosing a replacement source, show it beside the old image so the user can confirm it is the right photo. The user can select originals for several entries in one session and assign each to its entry. An imported original becomes the starting point for that entry's processing.

## Process as before

Use the existing processing pipeline and photo-history controls: colour correction, background removal, cropping and manual edits. Prefill the previous processing steps where known; otherwise use the user's current settings. The user can change those choices.

Run processing for the selected entries and put the results into **Needs review**. These results are candidates. Processing a candidate does not change the current product image.

## Review every candidate

For each entry, show three images with zoom:

- **Current image** — what the product uses now.
- **New original** — the freshly imported source.
- **New candidate** — the processed result being reviewed.

Show where the image is used, including gallery positions and variants. Give the user these actions:

- **Approve and update** — replace the current image with this candidate in the displayed uses, keeping gallery order and variant assignments. Send the updated images through the existing Shopify sync. Mark the entry Done when the update succeeds; show Retry if it fails.
- **Redo processing** — return to the existing controls, change steps or edit manually, and generate another candidate. The user can start from the new original or a chosen processing step.
- **Choose another original** — select or upload a different source and process it.
- **Later** — leave the entry in the queue and move on.

Every candidate requires manual approval. There is no automatic approval or bulk approve action. Where one source has several different edited versions, each replacement candidate gets its own review.

## Implementation

Keep a repair entry with its affected image uses, new original, candidate, processing choices and review status. Reuse the current importer, processing tools, history view and Shopify sync. Keep repair candidates separate from the active product photo until approval; the normal photo completion actions currently update active photo state, so they cannot be used unchanged for candidates.

Build this in three pieces:

1. Fix the downloader and make fresh re-import and redo bypass old results. Cover the preview-download regression with a focused test.
2. Add the repair queue and source selection, then connect existing processing controls to candidates.
3. Add side-by-side review and Approve and update. Walk all three calendar images for JAN `4542804169317` through the complete flow before working through the rest of the queue.

The flow is complete when the user can import a correct source, process it, reject and redo the result, approve it, and see the replacement on the product without losing its position or variant assignment.

## Incident evidence

See the [bug summary](../../PHOTO_IMPORT_BUG.md) and [October 26 audit](../investigations/PHOTO_RESOLUTION_AUDIT_2026-10-26.md). The audit is the starting inventory of affected photos; the repair queue tracks the work from here.
