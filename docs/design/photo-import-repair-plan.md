# Photo import repair plan

The repair queue starts from stocked items and their current photos. Re-import and process only the images that still need work. Each replacement is reviewed before approval; a current good image can be dismissed without importing anything.

## Current stock and photo selection

Use `quantity - shipped > 0` to select inventory items belonging to an existing saved listing, across all manufacturers. Exclude standalone inventory and library photos. Inspect their assigned images and the saved gallery images of their listings. If an assigned image is blank, use the first saved gallery image as its current fallback. If neither exists, create a missing-photo task.

Group current uses by image file, including known Drive/CDN aliases. Library and JAN-group references join a task only when that image is currently used by a stocked item or its saved gallery. Historical bad imports do not create work by themselves. Keep the earlier discovery events and any imports, attempts or approvals; the main queue is a new projection over current stock and files.

**Check stocked item photos** reads Drive image dimensions where available, otherwise the current full image's dimensions. Record those returned facts. Reuse an existing successful measurement for an unchanged URL; retry unreadable images and check new files/Shopify master versions. Files smaller than 1024 pixels on the longest side enter the queue. Larger files stay out by default. Failed reads enter **Needs a look**, not an automatic good result.

An explicit **Photo is good** decision dismisses the file across its displayed uses. **Other stocked photos** allows the user to flag a large but blurry, wrong or unsuitable image. Explicit visual decisions take priority over dimensions. An approved replacement records a good decision for its output file. New file IDs and changed Shopify master `v` values are checked independently; display-width parameters do not invalidate a decision.

All three views show one row per saved listing, with photo thumbnails using the shared hover preview and individual photo actions. Shared files can appear under each listing that uses them, while still sharing one repair entry. Count listing stock once across its variants, not once per photo. The UI counts listings needing attention and skipped current photos separately. Previously detected entries matching current stocked use remain in the main queue while their current measurement is unknown; a fresh check is not a prerequisite for restoring them after reload. Known good and repaired photos stay excluded. **Saved work** groups recorded entries belonging to saved listings, including discovery-only entries, prior imports, attempts, deferred decisions and completed repairs, without adding unused/zero-stock discovery records to the main queue.

## Fix the bug

Remove the bare Google Photos URL from the source download candidates. Download using `=d`; if that fails, show the import failure and let the user retry or select the original again. Do not fall back to a preview.

A re-import must fetch a fresh source instead of returning the old cached Drive copy. Redoing processing must actually run it again instead of returning the previous cached result. Make those two actions work in both browser and server paths.

## Open the repair queue

Open **Repair imported photos** from Photos, then choose **Check stocked item photos**. The main **Needs photos** view lists current small or missing images and files needing a visual decision. Put stocked uses first and group repeated uses of one file. Original-import history is a source lookup, not the eligibility test.

Use **Other stocked photos** to flag any current photo the automatic size check cannot judge. Use **Saved work** to reopen work from the prior discovery. Progress and decisions survive reload.

## Get the correct originals into the system

The default opening screen is **1. Select originals**. Derive pending sources from existing repair entries that still match stocked listing photos and need work or a current visual decision. Exclude approved/good photos, sources with a successful imported original, and duplicate entries for the same source. Display one capture-date batch at a time with original filenames and reference thumbnails; capture dates come from saved photo metadata and use the browser’s local time zone.

The user copies the date for search and opens a new Google Photos Picker session. The app cannot prefill or position Google’s picker. The user can select a broad batch; after selection, list the session’s media items and match their persistent `id` against `sourcesById[sourceId].originalGoogleMediaId` across all eligible repair sources, regardless of the currently displayed date. Do not guess matches from filenames. Download only matched sources; unrelated photos remain unassigned and can be manually assigned from an individual repair if necessary. Skip originals already imported or importing. A failed import can be selected again.

Request matching imports immediately while fresh download URLs are usable, then enter **2. Process and review**. Each request uses the existing `photoRepair/originalRequested` event with `{sourceId, importId, requestId, choice:{kind:"google_photos", mediaItemId, filename}}` and the existing transfer request containing the freshly selected `sourceBaseUrl`. Completion/failure still records `originalImported`/`originalFailed` under the same repair source. No new IDs are assigned to existing listing photos; no listing reference changes until individual approval. No new reducer fields, event types, or schema version are needed. The current screen and last open repair entry ID are remembered only in tab session storage; reload restores the open repair once its recorded entry is available. The selection screen provides a prominent Resume button and a listing-grouped imported-originals section, so successful imports remain discoverable without selecting them again. Source imports, processing and decisions remain event-backed.

Remove repair actions that attempt to re-download months-old URLs. Google Photos selection does not grant permanent API download access. Keep individual file upload and choosing an existing durable photo as alternatives, without adding bulk folder import.

Open a blank picker window directly from the user’s click, then navigate it when session creation returns. Provide the picker link if popups are blocked. Poll until the session’s returned expiration rather than imposing the former five-minute selection timeout. Imported originals stay available after reload, and selecting another batch does not restart completed imports or processing.

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

## IDs and files

These are separate identities. None is inferred from a filename or JAN.

| ID                 | Meaning                                                                         | What happens during repair                                                            |
| ------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Existing photo ID  | Current `MediaItem.id` used by the registry, groups, history and draft ordering | Keep it. Approval changes its applicable image references, not its identity.          |
| Google media ID    | ID returned when the user selects a source in Google Photos                     | Record it as source information. It may differ from the existing photo ID.            |
| Repair source ID   | App-generated UUID grouping entries that can use the same original              | Shared original download; entries may still need different edits and reviews.         |
| Import ID          | App-generated UUID for one attempt to bring in an original                      | A new ID for a fresh import or source reselection.                                    |
| Entry ID           | App-generated UUID for one existing image version and the uses being replaced   | One review task; distinct existing edits of one photo have separate entries.          |
| Attempt ID         | App-generated UUID for one processing attempt on an entry                       | Redo creates a new attempt, retaining the earlier candidate.                          |
| Candidate photo ID | `repair:<entryId>:<attemptId>`                                                  | Used only inside repair processing. Never added to the active registry or JAN groups. |
| Drive file ID      | ID assigned by Drive to each uploaded original or edit                          | New file IDs and URLs for the new source and processing results.                      |
| Shopify image ID   | ID assigned by Shopify when media is uploaded                                   | Can change on sync. It is not our photo ID or listing image ID.                       |

The imported original uses worker identity `repair-source:<sourceId>:<importId>`. Processing uses the candidate photo ID. These identities keep old cached imports and old processing results out of new work. Retries of the same operation retain its request ID; an explicit Re-import or Redo creates a new operation ID.

## Data recorded in broadcast

Add a `photoRepair` root slice. Its contents are reconstructed from `photoRepair/*` events in the existing `broadcast` collection. There is no separately saved copy of the entire repair queue.

All events use the existing envelope `{ type, payload, creator, timestamp }`. The Firestore document ID is the event ID; `timestamp` is the server timestamp normalized to `_timestamp` during replay. IDs below are allocated before saving an event. Reducers allocate no IDs and do no file or network work. Duplicate deliveries of the same event must not append duplicate entries, history or approvals.

The following types describe recorded payload data. In the payload tables, unannotated IDs, URLs, keys, filenames and messages are strings. Fields ending in `Id` are references, not embedded copies of other records. Optional values are omitted rather than written as `undefined`. Queue, source-choice, processing-choice, Later and approval events are written by the signed-in user; worker results are written by the worker under its existing service creator identity.

```ts
type EvidenceKind = "bad_import" | "other_small_image";
type PublicationOutcome = "completed" | "failed";

type Artifact = {
  driveFileId: string;
  url: string; // Durable URL used to display and process this file.
  webViewLink: string;
  filename: string;
  mimeType: string;
};

type OriginalChoice =
  | { kind: "existing_photo"; photoId: string; url: string; filename: string }
  | { kind: "google_photos"; mediaItemId: string; filename: string }
  | { kind: "upload"; filename: string; mimeType: string };

type TargetRef =
  | { kind: "photo_registry"; photoId: string }
  | { kind: "photo_selected"; photoId: string }
  | { kind: "photo_group"; groupKey: string; photoId: string }
  | { kind: "inventory"; itemKey: string }
  | { kind: "listing_image"; handle: string; imageId: string }
  | {
      kind: "listing_new_image";
      handle: string;
      imageId: string;
      altText: string;
    }
  | { kind: "proposal_image"; proposalKey: string; imageId: string }
  | { kind: "proposal_variant"; proposalKey: string; variantId: string };

type Target = {
  ref: TargetRef;
  beforeUrl: string; // Exact stored URL of this occurrence when chosen.
};

type Step =
  | { kind: "color_correct" }
  | { kind: "remove_bg" }
  | { kind: "smart_crop" }
  | {
      kind: "manual_crop";
      x: number;
      y: number;
      width: number;
      height: number;
      inputWidth: number;
      inputHeight: number;
      rotate?: number;
    };
```

`proposalKey` is the key in `listingCreation.proposals`; `variantId` is the existing `ListingVariant.id`. Manual crop coordinates are pixels in the displayed input image after orientation is applied, with origin at its top left. Manual crops also record the rotation from the existing crop tool. The browser uploads its rendered PNG and records that output against the crop step. Array order is processing order. The UI calls `smart_crop` simply Crop and distinguishes manual crop in its controls.

A target identifies one field occurrence. Do not replace every occurrence of a URL across the database. Use Drive file identity to discover alternate URL forms, but record each occurrence's actual stored `beforeUrl`. A listing image ID can differ from a photo ID; keep both as they are.

### Queue and source events

| Type                            | Complete payload                                                                                                                                | Effect                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `photoRepair/sourceAdded`       | `{ sourceId, originalGoogleMediaId?: string }`                                                                                                  | Add the shared source record.                                                                         |
| `photoRepair/entryAdded`        | `{ entryId, sourceId, existingPhotoId?: string, oldImageUrl, targets: Target[], evidence: { kind: EvidenceKind, transferEventIds: string[] } }` | Add a review task and its existing uses. Empty event IDs are allowed for manually added small images. |
| `photoRepair/targetsChanged`    | `{ entryId, targets: Target[] }`                                                                                                                | Replace the chosen uses before approval.                                                              |
| `photoRepair/originalRequested` | `{ sourceId, importId, requestId, choice: OriginalChoice }`                                                                                     | Select the current import and show Importing.                                                         |
| `photoRepair/originalImported`  | `{ sourceId, importId, requestId, artifact: Artifact }`                                                                                         | Record the downloaded/uploaded original.                                                              |
| `photoRepair/originalFailed`    | `{ sourceId, importId, requestId, message }`                                                                                                    | Show Retry or Select original.                                                                        |
| `photoRepair/laterChanged`      | `{ entryId, later: boolean }`                                                                                                                   | Persist Later or Resume.                                                                              |

Product titles, JANs, stock and current publication state are read from existing data for display and sorting. Do not freeze them into every event. `oldImageUrl` is the before picture for review; the target list is the exact replacement scope. Several entries can share `sourceId` while having different `oldImageUrl` values and targets.

Fresh Picker base URLs and file bytes are request inputs, not durable source identity. Tokens use the existing secret handoff and never enter these broadcast payloads.

### Processing events

| Type                         | Complete payload                                                                                     | Effect                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `photoRepair/attemptStarted` | `{ entryId, attemptId, importId, startStepIndex?: number, parentAttemptId?: string, steps: Step[] }` | Select the new attempt. Without a parent it starts from the imported original. With a parent it starts from that attempt's recorded output at `startStepIndex`. |
| `photoRepair/stepRequested`  | `{ attemptId, stepIndex, requestId }`                                                                | Queue this step, using the original or previous recorded step result as input.                                                                                  |
| `photoRepair/stepCompleted`  | `{ attemptId, stepIndex, requestId, artifact: Artifact }`                                            | Record the output and make it available to the next step.                                                                                                       |
| `photoRepair/stepFailed`     | `{ attemptId, stepIndex, requestId, message }`                                                       | Show the failed step and Retry or Redo.                                                                                                                         |

`stepIndex` is zero-based in the new attempt's `steps` array. For a parent attempt, `startStepIndex` is the zero-based index of the completed parent output used as input; it is not an index in the new steps. Parent and new attempt belong to the same entry and imported original. Starting again from the original omits both parent fields.

There is no separate candidate-completed event: the last step result is the candidate. An empty `steps` array means use the imported original as the candidate. Review status follows from those recorded results. Late results from a previous attempt remain in its history and cannot become the selected candidate.

A failed original import is retried with a new import ID and request ID. A retry of a failed step gets a new request ID under the same attempt and step. Its result supersedes the failed request for that step; completion is matched to the currently requested ID. Redo starts a new attempt. These are ordinary processing choices, not edits to earlier events.

### Approval and Shopify events

| Type                               | Complete payload                                                                           | Effect                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `photoRepair/approved`             | `{ approvalId, entryId, attemptId, targets: Target[] }`                                    | Apply the selected candidate in one root transition. Record user/time from the envelope. |
| `photoRepair/publicationRequested` | `{ publicationId, handle, approvalIds: string[], requestId }`                              | Link approvals to an ordinary Shopify request.                                           |
| `photoRepair/publicationFinished`  | `{ publicationId, requestId, outcome: PublicationOutcome, syncEventId, message?: string }` | Record the Shopify worker result; expose Retry on failure.                               |

An approval must name the entry's selected, completed attempt. The approval payload records the actual uses the user saw and approved. It references the attempt's recorded candidate rather than carrying a replacement URL supplied by the UI. Repeated approval of an already approved entry does nothing. Choosing a different candidate or scope after approval is a new repair entry.

The reducer first resolves the whole approval. If a listed target is missing or no longer has `beforeUrl`, change no product references and show that the uses need refreshing. Record that result under the approval event ID in replay state; the user can refresh targets and approve again with a new approval ID. This prevents one approval leaving half the references on the old image.

## Current photo facts and decisions

Add these broadcast events using the same envelope and timestamps as the repair events above:

| Type                             | Complete payload                                                     | Meaning                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `photoRepair/imageMeasured`      | `{ url: string, width?: number, height?: number, message?: string }` | Dimensions returned for the current file, or a failed read message. No good/bad verdict is stored by the measurement.                         |
| `photoRepair/photoReviewChanged` | `{ url: string, relatedUrls?: string[], good: boolean }`             | The user says the displayed file is good, or flags it as needing a better photo. Related URLs identify the displayed uses of that same asset. |

The repair slice adds optional maps for backward-compatible reads: `measurementsByKey` stores the measurement payload plus its `Fact`; `photoReviewsByKey` stores `{url, good, fact}`. Keys use Drive file identity or the CDN file path plus Shopify's master `v` value. Ignore display-size query parameters. Unchecked, missing, small, good-sized and needs-a-look labels are derived, not additional events.

A missing-photo entry records an empty `oldImageUrl` and an inventory target with empty `beforeUrl`. If it has a saved listing, also record `listing_new_image` with the stable slot ID `repair-photo-<itemKey>` and the proposed alt text. Approval fills that inventory field and appends that gallery slot; it does not invent an old photo ID. The imported source and candidate remain recorded in the repair history.

## Replay state

The root state is `state.photoRepair: PhotoRepairState`. These are reducer-owned projections of the events above, not additional payloads to broadcast. `Fact.atMs` comes from the recorded event timestamp.

```ts
type Fact = { eventId: string; creator: string; atMs: number };
type Result = {
  fact: Fact;
  artifact?: Artifact;
  message?: string;
}; // Completion has artifact; failure has message.

type ImportRecord = {
  fact: Fact;
  importId: string;
  requestId: string;
  choice: OriginalChoice;
  result?: Result;
};

type SourceRecord = {
  fact: Fact;
  sourceId: string;
  originalGoogleMediaId?: string;
  currentImportId?: string;
  importsById: Record<string, ImportRecord>;
};

type EntryRecord = {
  fact: Fact;
  entryId: string;
  sourceId: string;
  existingPhotoId?: string;
  oldImageUrl: string;
  targets: Target[];
  evidence: { kind: EvidenceKind; transferEventIds: string[] };
  later: boolean;
  attemptIds: string[];
  selectedAttemptId?: string;
  approvalId?: string; // Set only when approval actually applies.
};

type StepRun = {
  currentRequestId: string;
  requestsById: Record<string, { fact: Fact; result?: Result }>;
};

type AttemptRecord = {
  fact: Fact;
  attemptId: string;
  entryId: string;
  importId: string;
  parentAttemptId?: string;
  startStepIndex?: number;
  steps: Step[];
  runsByStep: Record<number, StepRun>;
};

type ApprovalRecord = {
  fact: Fact; // The approving user and time.
  approvalId: string;
  entryId: string;
  attemptId: string;
  targets: Target[];
  result: "applied" | "references_changed";
  affectedHandles: string[];
};

type PublicationRecord = {
  fact: Fact;
  publicationId: string;
  handle: string;
  approvalIds: string[];
  requestId: string;
  result?: {
    fact: Fact;
    outcome: PublicationOutcome;
    syncEventId: string;
    message?: string;
  };
};

type PhotoRepairState = {
  sourcesById: Record<string, SourceRecord>;
  entriesById: Record<string, EntryRecord>;
  attemptsById: Record<string, AttemptRecord>;
  approvalsById: Record<string, ApprovalRecord>;
  publicationsById: Record<string, PublicationRecord>;
  photoReviewsByKey?: Record<
    string,
    { url: string; good: boolean; fact: Fact }
  >;
  measurementsByKey?: Record<
    string,
    {
      url: string;
      width?: number;
      height?: number;
      message?: string;
      fact: Fact;
    }
  >;
  seenEventIds: Record<string, true>;
  pendingEventsById: Record<
    string,
    {
      type: string;
      payload: RepairPayload;
      fact: Fact;
    }
  >;
};
```

`RepairPayload` is the union of the complete payload shapes in the event tables. `pendingEventsById` holds events awaiting referenced records; mark them seen only when applied. New maps start empty, `later` starts false and entry attempt lists start empty. Candidate URLs are resolved from the selected attempt's final successful step result, or its imported artifact when there are no steps; they are not stored a second time.

A new import becomes current without erasing earlier imports. For unapproved entries sharing that source, an attempt using the earlier import is shown as superseded; process the new original before approval. Completed entries remain Done. The approval must reference an attempt using the source's current import.

Needs original, Importing, Processing, Needs review, Updating and Done are derived labels. They are not separately recorded decisions. Later is a user decision. An approved entry is Updating until every required listing publication completes. Entries with no Shopify-synced listing are Done after local approval; `no_sync` listings remain local and the screen says so. A publication failure leaves the approved local image in place and offers Retry sync.

Process events only after their referenced source, import, entry or attempt exists. Hold events whose dependencies have not replayed yet, then fold them when those IDs arrive. Replay never downloads files, reruns processing or submits Shopify requests.

## Exact changes on approval

Resolve each target by its existing key and old URL, including every duplicate occurrence of that same version in a group. Keep other edits with the same photo ID unchanged. Replace only the image field shown below. Keep every existing object ID. Apply the replacement once across the root state, rather than broadcasting several independent field changes.

| Target kind        | Existing location                                                         | Change                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `photo_registry`   | `photos.registry[photoId]`                                                | Set `baseUrl` to candidate URL, `productUrl` to its Drive web-view link and `mimeType` to the candidate format.              |
| `photo_selected`   | Matching ID in `photos.selected`                                          | Same fields. Do not add/remove a selected photo.                                                                             |
| `photo_group`      | Matching ID in `photos.janCodeToPhotos[groupKey]`                         | Same fields. Keep membership and array position.                                                                             |
| `inventory`        | `inventory.idToItem[itemKey]`                                             | Set `image`. Keep `imagePosition`, JAN, subtype and quantities.                                                              |
| `listing_image`    | Matching ID in `listings.handleToListing[handle].images`                  | Set `url`. Keep ID, position, alt text and other image metadata; advance listing `lastUpdated` using the approval timestamp. |
| `proposal_image`   | Matching ID in `listingCreation.proposals[proposalKey].listingOnlyImages` | Set `url`; keep all other fields.                                                                                            |
| `proposal_variant` | Matching ID in the proposal's `variants`                                  | Set its explicit `image` override; keep `photoGroupKey` and variant identity.                                                |

For photo targets, compare `beforeUrl` with `baseUrl`; for inventory and proposal variants compare with `image`; for listing and proposal images compare with `url`. Keep the logical photo filename and original source metadata unchanged. Set the current photo MIME type to the candidate's actual format, since a processed PNG must not remain labelled HEIC. The new source's filename and Google media ID remain in the repair records; the existing photo ID continues to identify the same product photo slot.

When approval applies, prepend the candidate URL once to the history of `existingPhotoId` and every photo ID in the approved photo targets, retaining their prior history. Repeated uses of the same file can have distinct logical photo IDs. Do not copy candidate processing flags into `photos.edits[existingPhotoId]`; processing history for this repair lives under its attempt. Do not rewrite historical broadcast events or replace old URLs inside historical edit records.

Keep `photoGroupIds`, `photoGroupKey`, `listingImageOrder`, `excludedPhotoIds`, inventory keys, listing handles and item-to-handle mappings unchanged. If an existing photo ID has several current edited versions, an entry updates only the occurrences of its chosen old version. Other entries using that ID stay pending and keep their own before images.

The existing `photos/complete_upload` and `photos/complete_edit` actions cannot represent candidate completion: they immediately update active photo data. Repair operations emit the events above instead. They do not register their synthetic worker IDs as ordinary photos.

## Worker requests and publication

Reuse `request_photos_transfer` and `request_photos_transform`. Extend their payloads with the following routing field:

```ts
type RepairContext =
  | { kind: "original"; sourceId: string; importId: string }
  | { kind: "step"; entryId: string; attemptId: string; stepIndex: number };
```

Each request keeps the existing envelope: `eventType`, `requestId`, `creator`, `requestedBy`, `source: "photo-repair"`, `photoId`, `filename`, `mimeType`, `payloadVersion: 2`, `createdAtMs` and server `timestamp`. Its payload contains `repair: RepairContext`, `photoId`, `sourceBaseUrl`, `sourceType`, `sourceRef`, `filename`, `mimeType`, `targetFolderId` and, for processing, `transform` plus the manual crop parameters when applicable. `sourceRef` contains the Google media ID or input Drive file ID. `sourceBaseUrl` can be a fresh Picker URL in the operational request, but completion facts retain the durable Drive output.

The worker resolves a Photos URL using `sourceRef.mediaItemId`, not the synthetic `photoId`. Use source type `photos` for Google retrieval and `drive` for processing inputs; cache identity is a separate decision. For repair originals, generate the derivation key from `("repair_original", importId, "identity")`; for repair steps use `("repair_step", attemptId + "-" + stepIndex, transform)`. Keep existing transform versioning. A retry after an interrupted operation may reuse a successfully uploaded result for that same operation; Re-import and Redo have new IDs and cannot reuse the prior run. The repair screen skips the ordinary browser pre-upload/pre-transform cache lookup.

Map `smart_crop` to the existing worker transform `crop`. Add `manual_crop` handling using the recorded rectangle; colour correction and background removal use the existing `color_correct` and `remove_bg` implementations.

The request document ID is `requestId`. Save the request and its `originalRequested` or `stepRequested` broadcast event in one Firestore batch. An original local upload uses the existing Drive upload helper without its normal active-photo completion actions, and emits `originalImported` with the resulting file; its import/request ID still links it to the preceding `originalRequested` event. Raw local file bytes stay out of Firestore events.

Workers retain their existing started/completed/failed `sync` logging. Include the repair context in those payloads and emit the corresponding repair completion/failure event under a deterministic ID derived from the request ID. The repair branch skips the normal active-photo completion actions. Original download requests use `=d`; Drive transform inputs use the imported original or preceding step's Drive result. A new attempt starts a fresh processing run, while completed outputs within that attempt can be reused on request redelivery.

After approval has replayed, build a normal Shopify request from the updated listing and inventory using `buildAdminShopifyListingProjection` and `buildShopifySyncRequestEvent`. Save that request and `publicationRequested` together. Use one request per affected handle; all approvals already included in its projection can reference it. A retry creates a new publication/request ID and retains the earlier result. The repair screen resumes any approved entries still awaiting request creation when reopened. It never queues a publication merely because historical events are being replayed.

The current Shopify worker rebuilds the product gallery and variant image attachments, so Shopify image IDs can change for the whole gallery. Send the full current gallery in its existing order, with unapproved images still using their current URLs. Record its existing final sync event ID in `publicationFinished`; no new Shopify image IDs are written into local photo IDs or local listing image IDs. The worker must emit that finish event for repair-linked requests even if the browser has closed.

The request needs an optional `repairPublicationId` alongside its existing request fields so the Shopify worker can emit this link. Existing sync logs and catalogue readback continue to hold remote product/image IDs. The new event stores the link and outcome, not a second copy of the remote product.

## Implementation sequence

1. Fix the downloader and fresh re-import/redo behavior, with a focused test for the preview-download regression.
2. Add the repair slice and events, then queue/source selection and candidate processing using the existing tools.
3. Add approval as one root transition and connect it to the existing Shopify request/result flow.

Schema version 30 rebuilds browser caches for current-photo decisions and the corrected duplicate-reference approval behavior. Existing photo events keep their existing behavior. The new routing field applies only to repair work; no existing IDs or historical events are migrated.

Verify the complete flow on the three calendar images for JAN `4542804169317`: import, process, redo, approve, reload and sync. Check that candidates do not change current data and that approval preserves identity, gallery order and variant assignments. Then work through the repair queue with manual review of every candidate.

## Incident evidence

See the [bug summary](../../PHOTO_IMPORT_BUG.md) and [October 26 audit](../investigations/PHOTO_RESOLUTION_AUDIT_2026-10-26.md). The audit is the starting inventory of affected photos; the repair queue tracks the work from here.
