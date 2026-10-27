import {
  initialPhotoRepair,
  originalFor,
  type EntryRecord,
} from "./photo-repair";
import {
  photoNeedsWork,
  preferredStockEntry,
  taskAssessment,
  taskForEntry,
  type PhotoAudit,
  type StockPhotoTask,
} from "./photo-repair-scope";
import type { MediaItem } from "./google-photos";

export function repairSelectionSources(
  root: any,
  tasks: StockPhotoTask[],
  audit?: PhotoAudit,
  includeImported = false,
) {
  const repair = root.photoRepair || initialPhotoRepair;
  const sources = new Map<
    string,
    {
      entry: EntryRecord;
      mediaItemId: string;
      filename: string;
      capturedAt: string;
      date: string;
      title: string;
      url: string;
      importing: boolean;
      imported: boolean;
      importedAt: number;
      task: StockPhotoTask;
    }
  >();
  for (const entry of Object.values(repair.entriesById) as EntryRecord[]) {
    if (entry.approvalId || sources.has(entry.sourceId)) continue;
    const task = taskForEntry(root, entry, tasks, audit);
    if (
      !task ||
      preferredStockEntry(root, task, audit)?.entryId !== entry.entryId
    )
      continue;
    const assessment = taskAssessment(root, task);
    if (assessment !== "Not checked" && !photoNeedsWork(assessment)) continue;
    const original = originalFor(repair, entry);
    if (original?.result?.artifact && !includeImported) continue;
    const source = repair.sourcesById[entry.sourceId];
    const mediaItemId = source?.originalGoogleMediaId || "";
    const photo =
      root.photos.registry[entry.existingPhotoId || mediaItemId] ||
      root.photos.registry[mediaItemId];
    const capturedAt = photo?.mediaMetadata?.creationTime || "";
    const date = capturedAt ? new Date(capturedAt) : undefined;
    sources.set(entry.sourceId, {
      entry,
      mediaItemId,
      filename: photo?.filename || "Unknown filename",
      capturedAt,
      date:
        date && !Number.isNaN(date.getTime())
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
          : "Unknown date",
      title: task.title,
      url: task.url,
      importing: !!original && !original.result,
      imported: !!original?.result?.artifact,
      importedAt: original?.result?.fact?.atMs || 0,
      task,
    });
  }
  return [...sources.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.filename.localeCompare(b.filename),
  );
}

export function matchRepairSelections(
  sources: ReturnType<typeof repairSelectionSources>,
  photos: MediaItem[],
) {
  const picked = new Map(photos.map((photo) => [photo.id, photo]));
  const matches = sources.flatMap((source) => {
    const photo = picked.get(source.mediaItemId);
    return photo && !source.importing && !source.imported
      ? [{ source, photo }]
      : [];
  });
  const matchedIds = new Set(matches.map((match) => match.photo.id));
  return {
    matches,
    unmatched: [...picked.values()].filter(
      (photo) => !matchedIds.has(photo.id),
    ),
  };
}
