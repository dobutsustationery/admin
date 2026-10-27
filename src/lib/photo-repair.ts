import { createNextState as produce } from "@reduxjs/toolkit";
import { extractGoogleDriveFileId } from "./drive-url";

export type Artifact = {
  driveFileId: string;
  url: string;
  webViewLink: string;
  filename: string;
  mimeType: string;
};
export type Step =
  | { kind: "color_correct" | "remove_bg" | "smart_crop" }
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
export type TargetRef =
  | { kind: "photo_registry" | "photo_selected"; photoId: string }
  | { kind: "photo_group"; groupKey: string; photoId: string }
  | { kind: "inventory"; itemKey: string }
  | { kind: "listing_image"; handle: string; imageId: string }
  | { kind: "proposal_image"; proposalKey: string; imageId: string }
  | { kind: "proposal_variant"; proposalKey: string; variantId: string };
export type Target = { ref: TargetRef; beforeUrl: string };
type Fact = { eventId: string; creator: string; atMs: number };
type Result = { fact: Fact; artifact?: Artifact; message?: string };
export type OriginalChoice =
  | { kind: "google_photos"; mediaItemId: string; filename: string }
  | { kind: "upload"; filename: string; mimeType: string };
export type ImportRecord = {
  fact: Fact;
  importId: string;
  requestId: string;
  choice: OriginalChoice;
  result?: Result;
};
export type SourceRecord = {
  fact: Fact;
  sourceId: string;
  originalGoogleMediaId?: string;
  currentImportId?: string;
  importsById: Record<string, ImportRecord>;
};
export type EntryRecord = {
  fact: Fact;
  entryId: string;
  sourceId: string;
  existingPhotoId?: string;
  oldImageUrl: string;
  targets: Target[];
  evidence: {
    kind: "bad_import" | "other_small_image";
    transferEventIds: string[];
  };
  later: boolean;
  attemptIds: string[];
  selectedAttemptId?: string;
  approvalId?: string;
};
export type AttemptRecord = {
  fact: Fact;
  attemptId: string;
  entryId: string;
  importId: string;
  parentAttemptId?: string;
  startStepIndex?: number;
  steps: Step[];
  runsByStep: Record<
    number,
    {
      currentRequestId: string;
      requestsById: Record<string, { fact: Fact; result?: Result }>;
    }
  >;
};
export type ApprovalRecord = {
  fact: Fact;
  approvalId: string;
  entryId: string;
  attemptId: string;
  targets: Target[];
  result: "applied" | "references_changed";
  affectedHandles: string[];
};
export type PublicationRecord = {
  fact: Fact;
  publicationId: string;
  handle: string;
  approvalIds: string[];
  requestId: string;
  result?: {
    fact: Fact;
    outcome: "completed" | "failed";
    syncEventId: string;
    message?: string;
  };
};
export type PhotoRepairState = {
  sourcesById: Record<string, SourceRecord>;
  entriesById: Record<string, EntryRecord>;
  attemptsById: Record<string, AttemptRecord>;
  approvalsById: Record<string, ApprovalRecord>;
  publicationsById: Record<string, PublicationRecord>;
  seenEventIds: Record<string, true>;
  pendingEventsById: Record<string, any>;
};
export const initialPhotoRepair: PhotoRepairState = {
  sourcesById: {},
  entriesById: {},
  attemptsById: {},
  approvalsById: {},
  publicationsById: {},
  seenEventIds: {},
  pendingEventsById: {},
};
export function originalFor(s: PhotoRepairState, e: EntryRecord) {
  const source = s.sourcesById[e.sourceId];
  return source?.importsById[source.currentImportId || ""];
}
export function stepOutput(a: AttemptRecord, i: number): Artifact | undefined {
  const run = a.runsByStep[i];
  return run?.requestsById[run.currentRequestId]?.result?.artifact;
}
export function attemptInput(
  s: PhotoRepairState,
  a: AttemptRecord,
): Artifact | undefined {
  if (a.parentAttemptId)
    return stepOutput(s.attemptsById[a.parentAttemptId], a.startStepIndex!);
  const e = s.entriesById[a.entryId];
  return s.sourcesById[e.sourceId]?.importsById[a.importId]?.result?.artifact;
}
export function candidateFor(
  s: PhotoRepairState,
  e: EntryRecord,
): Artifact | undefined {
  const a = s.attemptsById[e.selectedAttemptId || ""];
  if (!a || a.importId !== s.sourcesById[e.sourceId]?.currentImportId) return;
  return a.steps.length
    ? stepOutput(a, a.steps.length - 1)
    : attemptInput(s, a);
}
export function repairStatus(s: PhotoRepairState, e: EntryRecord): string {
  if (e.approvalId) {
    const approval = s.approvalsById[e.approvalId];
    const pubs = Object.values(s.publicationsById).filter((p) =>
      p.approvalIds.includes(e.approvalId!),
    );
    if (
      approval.affectedHandles.every((h) =>
        pubs.some((p) => p.handle === h && p.result?.outcome === "completed"),
      )
    )
      return "Done";
    if (
      pubs.some(
        (p) =>
          p.result?.outcome === "failed" &&
          !pubs.some(
            (q) =>
              q.handle === p.handle &&
              (!q.result || q.result.outcome === "completed"),
          ),
      )
    )
      return "Sync failed";
    return "Updating";
  }
  if (e.later) return "Later";
  const imp = originalFor(s, e);
  if (!imp || imp.result?.message) return "Needs original";
  if (!imp.result?.artifact) return "Importing";
  if (candidateFor(s, e)) return "Needs review";
  const a = s.attemptsById[e.selectedAttemptId || ""];
  if (!a || a.importId !== imp.importId) return "Ready to process";
  if (
    Object.values(a.runsByStep).some(
      (r) => r.requestsById[r.currentRequestId]?.result?.message,
    )
  )
    return "Processing failed";
  return "Processing";
}
export function resolveTarget(
  root: any,
  ref: TargetRef,
): { object: any; field: string } | undefined {
  let object: any,
    field = "url";
  switch (ref.kind) {
    case "photo_registry":
      object = root.photos.registry[ref.photoId];
      field = "baseUrl";
      break;
    case "photo_selected":
      object = root.photos.selected.find((p: any) => p.id === ref.photoId);
      field = "baseUrl";
      break;
    case "photo_group":
      object = root.photos.janCodeToPhotos[ref.groupKey]?.find(
        (p: any) => p.id === ref.photoId,
      );
      field = "baseUrl";
      break;
    case "inventory":
      object = root.inventory.idToItem[ref.itemKey];
      field = "image";
      break;
    case "listing_image":
      object = root.listings.handleToListing[ref.handle]?.images.find(
        (p: any) => p.id === ref.imageId,
      );
      break;
    case "proposal_image":
      object = root.listingCreation.proposals[
        ref.proposalKey
      ]?.listingOnlyImages?.find((p: any) => p.id === ref.imageId);
      break;
    case "proposal_variant":
      object = root.listingCreation.proposals[ref.proposalKey]?.variants.find(
        (p: any) => p.id === ref.variantId,
      );
      field = "image";
      break;
  }
  return object ? { object, field } : undefined;
}
function handlesFor(root: any, targets: Target[]): string[] {
  const handles = new Set<string>();
  for (const { ref } of targets) {
    if (ref.kind === "listing_image") handles.add(ref.handle);
    if (ref.kind === "inventory") {
      const handle =
        root.listings.idToHandle[ref.itemKey] ||
        root.inventory.idToItem[ref.itemKey]?.handle;
      if (handle) handles.add(handle);
    }
  }
  return [...handles]
    .filter((h) => root.listings.handleToListing[h]?.status !== "no_sync")
    .sort();
}
function fold(root: any, a: any): boolean {
  const s: PhotoRepairState = root.photoRepair,
    p = a.payload || {};
  const f: Fact = {
    eventId: a.id,
    creator: a.creator || "",
    atMs: a._timestamp || 0,
  };
  const source = s.sourcesById[p.sourceId],
    e = s.entriesById[p.entryId],
    attempt = s.attemptsById[p.attemptId];
  switch (a.type) {
    case "photoRepair/sourceAdded":
      s.sourcesById[p.sourceId] ||= { ...p, fact: f, importsById: {} };
      break;
    case "photoRepair/entryAdded":
      if (!source) return false;
      s.entriesById[p.entryId] ||= {
        ...p,
        fact: f,
        later: false,
        attemptIds: [],
      };
      break;
    case "photoRepair/targetsChanged":
      if (!e) return false;
      if (!e.approvalId) e.targets = p.targets;
      break;
    case "photoRepair/laterChanged":
      if (!e) return false;
      e.later = p.later;
      break;
    case "photoRepair/originalRequested":
      if (!source) return false;
      source.importsById[p.importId] ||= {
        fact: f,
        importId: p.importId,
        requestId: p.requestId,
        choice: p.choice,
      };
      source.currentImportId = p.importId;
      break;
    case "photoRepair/originalImported":
    case "photoRepair/originalFailed": {
      const imp = source?.importsById[p.importId];
      if (!imp) return false;
      if (imp.requestId === p.requestId)
        imp.result = {
          fact: f,
          ...(p.artifact ? { artifact: p.artifact } : { message: p.message }),
        };
      break;
    }
    case "photoRepair/attemptStarted":
      if (!e || !s.sourcesById[e.sourceId]?.importsById[p.importId])
        return false;
      if (p.parentAttemptId && !s.attemptsById[p.parentAttemptId]) return false;
      s.attemptsById[p.attemptId] ||= { ...p, fact: f, runsByStep: {} };
      if (!e.attemptIds.includes(p.attemptId)) e.attemptIds.push(p.attemptId);
      if (!e.approvalId) {
        e.selectedAttemptId = p.attemptId;
        e.later = false;
      }
      break;
    case "photoRepair/stepRequested": {
      if (!attempt) return false;
      const run = (attempt.runsByStep[p.stepIndex] ||= {
        currentRequestId: p.requestId,
        requestsById: {},
      });
      run.currentRequestId = p.requestId;
      run.requestsById[p.requestId] ||= { fact: f };
      break;
    }
    case "photoRepair/stepCompleted":
    case "photoRepair/stepFailed": {
      const request =
        attempt?.runsByStep[p.stepIndex]?.requestsById[p.requestId];
      if (!request) return false;
      request.result = {
        fact: f,
        ...(p.artifact ? { artifact: p.artifact } : { message: p.message }),
      };
      break;
    }
    case "photoRepair/approved": {
      if (!e || !attempt) return false;
      if (e.approvalId) break;
      const artifact = candidateFor(s, e);
      if (!artifact || e.selectedAttemptId !== p.attemptId) return false;
      const resolved = p.targets.map((t: Target) => resolveTarget(root, t.ref));
      const valid =
        p.targets.length > 0 &&
        resolved.every(
          (r: any, i: number) =>
            r && r.object[r.field] === p.targets[i].beforeUrl,
        );
      s.approvalsById[p.approvalId] = {
        ...p,
        fact: f,
        result: valid ? "applied" : "references_changed",
        affectedHandles: valid ? handlesFor(root, p.targets) : [],
      };
      if (!valid) break;
      resolved.forEach((r: any, i: number) => {
        r.object[r.field] = artifact.url;
        if (r.field === "baseUrl") {
          r.object.productUrl = artifact.webViewLink;
          r.object.mimeType = artifact.mimeType;
        }
        const ref = p.targets[i].ref;
        if (ref.kind === "listing_image")
          root.listings.handleToListing[ref.handle].lastUpdated = Math.max(
            root.listings.handleToListing[ref.handle].lastUpdated || 0,
            f.atMs,
          );
      });
      const photoIds = new Set<string>(
        e.existingPhotoId ? [e.existingPhotoId] : [],
      );
      p.targets.forEach((t: Target) => {
        if ("photoId" in t.ref) photoIds.add(t.ref.photoId);
      });
      for (const photoId of photoIds) {
        const history = (root.photos.urlHistory[photoId] ||= []);
        if (history[0] !== artifact.url) history.unshift(artifact.url);
      }
      e.approvalId = p.approvalId;
      break;
    }
    case "photoRepair/publicationRequested":
      if (!p.approvalIds.every((id: string) => s.approvalsById[id]))
        return false;
      s.publicationsById[p.publicationId] ||= { ...p, fact: f };
      break;
    case "photoRepair/publicationFinished": {
      const pub = s.publicationsById[p.publicationId];
      if (!pub) return false;
      if (pub.requestId === p.requestId)
        pub.result = {
          fact: f,
          outcome: p.outcome,
          syncEventId: p.syncEventId,
          ...(p.message ? { message: p.message } : {}),
        };
      break;
    }
    default:
      break;
  }
  return true;
}
export function applyPhotoRepair(root: any, action: any): any {
  if (!action.type?.startsWith("photoRepair/") || !action.id) return root;
  return produce(root, (draft: any) => {
    const s: PhotoRepairState = draft.photoRepair;
    if (s.seenEventIds[action.id]) return;
    s.pendingEventsById[action.id] = action;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, a] of Object.entries(s.pendingEventsById)) {
        if (fold(draft, a)) {
          s.seenEventIds[id] = true;
          delete s.pendingEventsById[id];
          progressed = true;
        }
      }
    }
  });
}
export function approvedRepairAssets(s: PhotoRepairState): Set<string> {
  const keys = new Set<string>();
  for (const approval of Object.values(s.approvalsById)) {
    if (approval.result !== "applied") continue;
    const a = s.attemptsById[approval.attemptId];
    if (!a) continue;
    const artifact = a.steps.length
      ? stepOutput(a, a.steps.length - 1)
      : attemptInput(s, a);
    if (artifact) keys.add(imageKey(artifact.url));
  }
  return keys;
}
export function imageKey(url: string): string {
  const driveId = extractGoogleDriveFileId(url);
  if (driveId) return driveId;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "cdn.shopify.com")
      return `${parsed.origin}${parsed.pathname}`;
  } catch {
    /* Non-URL fixture/legacy references retain their exact key. */
  }
  return url;
}
export function allImageTargets(root: any): Target[] {
  const targets: Target[] = [];
  const push = (ref: TargetRef, url: any) => {
    if (url) targets.push({ ref, beforeUrl: String(url) });
  };
  Object.entries(root.photos.registry).forEach(([photoId, p]: any) =>
    push({ kind: "photo_registry", photoId }, p.baseUrl),
  );
  root.photos.selected.forEach((p: any) =>
    push({ kind: "photo_selected", photoId: p.id }, p.baseUrl),
  );
  Object.entries(root.photos.janCodeToPhotos).forEach(
    ([groupKey, photos]: any) =>
      photos.forEach((p: any) =>
        push({ kind: "photo_group", groupKey, photoId: p.id }, p.baseUrl),
      ),
  );
  Object.entries(root.inventory.idToItem).forEach(([itemKey, p]: any) =>
    push({ kind: "inventory", itemKey }, p.image),
  );
  Object.entries(root.listings.handleToListing).forEach(([handle, p]: any) =>
    p.images.forEach((i: any) =>
      push({ kind: "listing_image", handle, imageId: i.id }, i.url),
    ),
  );
  Object.entries(root.listingCreation.proposals).forEach(
    ([proposalKey, p]: any) => {
      (p.listingOnlyImages || []).forEach((i: any) =>
        push({ kind: "proposal_image", proposalKey, imageId: i.id }, i.url),
      );
      p.variants.forEach((v: any) =>
        push(
          { kind: "proposal_variant", proposalKey, variantId: v.id },
          v.image,
        ),
      );
    },
  );
  return targets;
}
export function entryDetails(root: any, e: EntryRecord) {
  const itemKeys = new Set<string>();
  const handles = new Set<string>();
  e.targets.forEach(({ ref }) => {
    if (ref.kind === "inventory") itemKeys.add(ref.itemKey);
    if (ref.kind === "listing_image") handles.add(ref.handle);
    if (ref.kind === "photo_group")
      Object.entries(root.inventory.idToItem).forEach(([id, item]: any) => {
        if (ref.groupKey === item.janCode || ref.groupKey === id)
          itemKeys.add(id);
      });
  });
  itemKeys.forEach((id) => {
    const h =
      root.listings.idToHandle[id] || root.inventory.idToItem[id]?.handle;
    if (h) handles.add(h);
  });
  handles.forEach((h) =>
    Object.entries(root.listings.idToHandle).forEach(([id, handle]) => {
      if (handle === h) itemKeys.add(id);
    }),
  );
  const items = [...itemKeys]
    .map((id) => root.inventory.idToItem[id])
    .filter(Boolean);
  const photo = root.photos.registry[e.existingPhotoId || ""];
  return {
    title:
      [...handles]
        .map((h) => root.listings.handleToListing[h]?.title)
        .filter(Boolean)
        .join(" / ") ||
      items[0]?.description ||
      photo?.filename ||
      "Unassigned photo",
    filename: photo?.filename || "",
    jans: [...new Set(items.map((i: any) => i.janCode))].join(", "),
    stock: items.reduce(
      (n: number, i: any) =>
        n + Math.max(0, Number(i.qty || 0) - Number(i.shipped || 0)),
      0,
    ),
    handles: [...handles],
  };
}
