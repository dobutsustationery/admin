import {
  approvedRepairAssets,
  allImageTargets,
  imageKey,
  photoCheckKey,
  type Target,
  type EntryRecord,
} from "./photo-repair";
export type StockPhotoTask = {
  key: string;
  url: string;
  targets: Target[];
  itemKeys: string[];
  handles: string[];
  title: string;
  jans: string;
  stock: number;
  missing: boolean;
};
export type PhotoMeasurement = {
  url: string;
  width?: number;
  height?: number;
  message?: string;
};
export type PhotoAudit = {
  sources: {
    photoId: string;
    transferEventIds: string[];
    driveIds: string[];
  }[];
  images: {
    photo_id: string;
    drive_id: string;
    url: string;
    classification: string;
  }[];
};
const aliasCache = new WeakMap<PhotoAudit, Map<string, string>>();
const taskCache = new WeakMap<
  object,
  { dependencies: any[]; tasks: StockPhotoTask[] }
>();
export function assetKey(url: string, audit?: PhotoAudit): string {
  const key = imageKey(url);
  if (!audit) return key;
  let aliases = aliasCache.get(audit);
  if (!aliases) {
    aliases = new Map();
    for (const i of audit.images) {
      if (i.drive_id) {
        aliases.set(imageKey(i.url), i.drive_id);
        aliases.set(i.drive_id, i.drive_id);
      }
    }
    aliasCache.set(audit, aliases);
  }
  return aliases.get(key) || key;
}
export function stockedPhotoTasks(
  root: any,
  audit?: PhotoAudit,
): StockPhotoTask[] {
  const dependencies = [
    root.inventory.idToItem,
    root.listings.handleToListing,
    root.listings.idToHandle,
    root.photos.registry,
    root.photos.janCodeToPhotos,
    root.photos.selected,
    root.listingCreation.proposals,
    audit,
  ];
  const previous = taskCache.get(root.inventory.idToItem);
  if (
    previous &&
    dependencies.every((value, i) => value === previous.dependencies[i])
  )
    return previous.tasks;
  const tasks = new Map<string, StockPhotoTask>();
  const inventory = root.inventory.idToItem || {},
    listings = root.listings.handleToListing || {};
  const stockItems = Object.entries(inventory).filter(
    ([, i]: any) => Number(i.qty || 0) - Number(i.shipped || 0) > 0,
  );
  const add = (itemKey: string, url: string, refs: Target[]) => {
    const item = inventory[itemKey],
      handle = root.listings.idToHandle[itemKey] || item.handle;
    const key = url ? assetKey(url, audit) : `missing:${itemKey}`;
    let task = tasks.get(key);
    if (!task) {
      task = {
        key,
        url,
        targets: [],
        itemKeys: [],
        handles: [],
        title: "",
        jans: "",
        stock: 0,
        missing: !url,
      };
      tasks.set(key, task);
    }
    if (!task.itemKeys.includes(itemKey)) {
      task.itemKeys.push(itemKey);
      task.stock += Number(item.qty || 0) - Number(item.shipped || 0);
    }
    if (handle && !task.handles.includes(handle)) task.handles.push(handle);
    task.targets.push(...refs);
  };
  for (const [itemKey, item] of stockItems as [string, any][]) {
    const handle = root.listings.idToHandle[itemKey] || item.handle;
    const listing = listings[handle];
    // Inventory images participate in a listing as variant images. Standalone
    // inventory and library photos are outside the repair workflow.
    if (!listing) continue;
    const images = [...(listing?.images || [])]
      .filter((i: any) => i.url)
      .sort((a: any, b: any) => a.position - b.position);
    const assigned = item.image || images[0]?.url || "";
    add(itemKey, assigned, [
      { ref: { kind: "inventory", itemKey }, beforeUrl: item.image || "" },
    ]);
    for (const image of images)
      add(itemKey, image.url, [
        {
          ref: { kind: "listing_image", handle, imageId: image.id },
          beforeUrl: image.url,
        },
      ]);
    if (!assigned && listing)
      add(itemKey, "", [
        {
          ref: {
            kind: "listing_new_image",
            handle,
            imageId: `repair-photo-${itemKey}`,
            altText: item.description || listing.title || "",
          },
          beforeUrl: "",
        },
      ]);
  }
  // Library/history references only follow a current stocked use; they do not create work.
  for (const target of allImageTargets(root)) {
    const task = tasks.get(assetKey(target.beforeUrl, audit));
    if (task) task.targets.push(target);
  }
  for (const task of tasks.values()) {
    const unique = new Map<string, Target>();
    for (const t of task.targets)
      unique.set(`${JSON.stringify(t.ref)}\n${t.beforeUrl}`, t);
    task.targets = [...unique.values()];
    task.title =
      task.handles
        .map((h) => listings[h]?.title)
        .filter(Boolean)
        .join(" / ") ||
      inventory[task.itemKeys[0]]?.description ||
      task.itemKeys[0];
    task.jans = [
      ...new Set(
        task.itemKeys.map((k) => inventory[k]?.janCode).filter(Boolean),
      ),
    ].join(", ");
  }
  const result = [...tasks.values()].sort(
    (a, b) => b.stock - a.stock || a.title.localeCompare(b.title),
  );
  taskCache.set(root.inventory.idToItem, { dependencies, tasks: result });
  return result;
}

export function groupRepairPhotosByListing<
  T extends { task?: StockPhotoTask; e?: EntryRecord },
>(root: any, photos: T[]) {
  const listings = root.listings.handleToListing || {};
  const inventory = root.inventory.idToItem || {};
  const groups = new Map<
    string,
    { handle: string; title: string; jans: string; stock: number; photos: T[] }
  >();
  for (const photo of photos) {
    const handles = photo.task
      ? photo.task.handles
      : (photo.e?.targets || []).flatMap(({ ref }) => {
          if (ref.kind === "listing_image" || ref.kind === "listing_new_image")
            return [ref.handle];
          if (ref.kind === "inventory") {
            const handle =
              root.listings.idToHandle[ref.itemKey] ||
              inventory[ref.itemKey]?.handle;
            return handle ? [handle] : [];
          }
          return [];
        });
    for (const handle of new Set(handles)) {
      if (!listings[handle]) continue;
      let group = groups.get(handle);
      if (!group) {
        const items = Object.entries(inventory)
          .filter(
            ([key, item]: [string, any]) =>
              (root.listings.idToHandle[key] || item.handle) === handle,
          )
          .map(([, item]) => item as any);
        group = {
          handle,
          title: listings[handle].title || handle,
          jans: [...new Set(items.map((i) => i.janCode).filter(Boolean))].join(
            ", ",
          ),
          stock: items.reduce(
            (sum, i) =>
              sum + Math.max(0, Number(i.qty || 0) - Number(i.shipped || 0)),
            0,
          ),
          photos: [],
        };
        groups.set(handle, group);
      }
      group.photos.push(photo);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.stock - a.stock || a.title.localeCompare(b.title),
  );
}
export function taskAssessment(root: any, task: StockPhotoTask): string {
  if (task.missing) return "Missing photo";
  const s = root.photoRepair;
  const review = s.photoReviewsByKey?.[photoCheckKey(task.url)];
  if (review?.good) return "Photo is good";
  if (review && !review.good) return "Needs a better photo";
  if (approvedRepairAssets(s).has(imageKey(task.url))) return "Repaired";
  const measured: PhotoMeasurement | undefined =
    s.measurementsByKey?.[photoCheckKey(task.url)];
  if (!measured) return "Not checked";
  if (measured.message || !measured.width || !measured.height)
    return "Needs a look";
  return Math.max(measured.width, measured.height) < 1024
    ? "Small photo"
    : "Good size";
}
export const photoNeedsWork = (assessment: string) =>
  [
    "Missing photo",
    "Small photo",
    "Needs a look",
    "Needs a better photo",
  ].includes(assessment);
export function taskForEntry(
  root: any,
  e: EntryRecord,
  tasks: StockPhotoTask[],
  audit?: PhotoAudit,
): StockPhotoTask | undefined {
  if (!e.oldImageUrl) {
    const keys = new Set(
      e.targets
        .filter((t) => t.ref.kind === "inventory")
        .map((t) => (t.ref as { itemKey: string }).itemKey),
    );
    return tasks.find((t) => t.missing && t.itemKeys.some((k) => keys.has(k)));
  }
  const key = assetKey(e.oldImageUrl, audit);
  return tasks.find((t) => !t.missing && t.key === key);
}

export function preferredStockEntry(
  root: any,
  task: StockPhotoTask,
  audit?: PhotoAudit,
): EntryRecord | undefined {
  const s = root.photoRepair;
  return (Object.values(s.entriesById) as EntryRecord[])
    .filter((e) => !e.approvalId && taskForEntry(root, e, [task], audit))
    .sort((a, b) => {
      const score = (e: EntryRecord) =>
        (e.selectedAttemptId ? 2 : 0) +
        (s.sourcesById[e.sourceId]?.currentImportId ? 1 : 0);
      return score(b) - score(a) || b.fact.atMs - a.fact.atMs;
    })[0];
}
