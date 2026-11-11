const { createHash } = require("node:crypto");
const imageField = (field) =>
  /^(main_product_image_locator|other_product_image_locator_[1-8])$/.test(
    field,
  );

// Amazon fetches these public delivery copies. Originals and their identities
// remain unchanged; source URLs are journaled alongside the exact sent payload.
function createImagePreparer({
  bucket,
  fetchImage = fetch,
  sharp = require("sharp"),
}) {
  async function deliveryUrl(source) {
    const url = new URL(source);
    if (url.protocol !== "https:")
      throw Error("Amazon images need a public HTTPS source.");
    if (
      url.hostname === "storage.googleapis.com" &&
      url.pathname.startsWith(`/${bucket.name}/amazon-images/`)
    )
      return source;
    const key = `amazon-images/v1/${createHash("sha256").update(source).digest("hex")}.jpg`;
    const file = bucket.file(key);
    const [exists] = await file.exists();
    if (!exists) {
      const response = await fetchImage(source, {
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok)
        throw Error(
          `Could not download Amazon source image (HTTP ${response.status}).`,
        );
      const input = Buffer.from(await response.arrayBuffer());
      const jpeg = await sharp(input)
        .rotate()
        .resize({
          width: 2048,
          height: 2048,
          fit: "inside",
          withoutEnlargement: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 90 })
        .toBuffer();
      await file.save(jpeg, {
        resumable: false,
        contentType: "image/jpeg",
        metadata: {
          cacheControl: "public,max-age=31536000,immutable",
          metadata: { sourceUrl: source },
        },
      });
    }
    return `https://storage.googleapis.com/${bucket.name}/${key}`;
  }
  return async function prepare(entry) {
    const patches = entry.syncPatches || entry.body.patches;
    const fields =
      entry.method === "PUT" &&
      !entry.updateExisting &&
      entry.syncIssue !== "category"
        ? Object.keys(entry.body.attributes || {}).filter(imageField)
        : (patches || [])
            .filter(
              (p) =>
                p.op !== "delete" &&
                imageField(p.path.replace("/attributes/", "")),
            )
            .map((p) => p.path.replace("/attributes/", ""));
    if (!fields.length) return entry;
    const copy = structuredClone(entry);
    copy.imageSources = { ...copy.imageSources };
    const urls = new Map();
    for (const field of fields) {
      const original =
        entry.imageSources?.[field] ||
        (entry.method === "PUT"
          ? entry.body.attributes[field]
          : patches.find((p) => p.path === `/attributes/${field}`).value);
      copy.imageSources[field] = structuredClone(original);
      const sent = [];
      for (const value of original) {
        const source = value.media_location;
        if (!urls.has(source)) urls.set(source, await deliveryUrl(source));
        sent.push({ ...value, media_location: urls.get(source) });
      }
      if (copy.method === "PUT") copy.body.attributes[field] = sent;
      for (const p of copy.syncPatches || copy.body.patches || [])
        if (p.path === `/attributes/${field}`) p.value = sent;
    }
    return copy;
  };
}
module.exports = { createImagePreparer };
