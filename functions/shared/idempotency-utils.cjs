"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if ((from && typeof from === "object") || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, {
          get: () => from[key],
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable,
        });
  }
  return to;
};
var __toCommonJS = (mod) =>
  __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/lib/idempotency-utils.ts
var idempotency_utils_exports = {};
__export(idempotency_utils_exports, {
  DERIVATION_KEY_PROPERTY: () => DERIVATION_KEY_PROPERTY,
  buildDerivationKeyQuery: () => buildDerivationKeyQuery,
  escapeDriveQueryValue: () => escapeDriveQueryValue,
  findFileByDerivationKey: () => findFileByDerivationKey,
  generateDerivationKey: () => generateDerivationKey,
  getVersionedTransform: () => getVersionedTransform,
  toDriveApiMediaUrl: () => toDriveApiMediaUrl,
  toDrivePublicUrl: () => toDrivePublicUrl,
});
module.exports = __toCommonJS(idempotency_utils_exports);
var DERIVATION_KEY_PROPERTY = "derivation_key";
function crc32(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function getVersionedTransform(transform) {
  if (transform === "remove_bg" || transform === "remove_background") {
    return "remove_bg_v2";
  }
  if (transform === "color_correct") {
    return "color_correct_v1";
  }
  if (transform === "crop") {
    return "crop_v3";
  }
  return transform;
}
function generateDerivationKey(type, id, transform) {
  if (!id) return null;
  const safeType = String(type || "unknown");
  const safeTransform = getVersionedTransform(String(transform || "identity"));
  let safeId = String(id).replace(/:/g, "_");
  const baseKey = `${safeType}:${safeId}:${safeTransform}`;
  if (baseKey.length > 110) {
    const hash = crc32(safeId);
    const prefix = safeId.slice(0, 32);
    safeId = `h_${prefix}_${hash}`;
  }
  return `${safeType}:${safeId}:${safeTransform}`;
}
function escapeDriveQueryValue(value) {
  if (!value) return "";
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function buildDerivationKeyQuery(derivationKey) {
  return `properties has { key='${DERIVATION_KEY_PROPERTY}' and value='${escapeDriveQueryValue(derivationKey)}' } and trashed=false`;
}
function toDriveApiMediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
}
function toDrivePublicUrl(fileId) {
  return `https://lh3.googleusercontent.com/d/${fileId}=s0`;
}
async function findFileByDerivationKey(derivationKey, executeRequest) {
  const query = buildDerivationKeyQuery(derivationKey);
  const fields =
    "id,name,mimeType,webViewLink,webContentLink,thumbnailLink,modifiedTime,size";
  const params = new URLSearchParams({
    q: query,
    fields: `files(${fields})`,
    pageSize: "1",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const url = `https://www.googleapis.com/drive/v3/files?${params.toString()}`;
  const data = await executeRequest(url);
  const first = (data.files || [])[0];
  if (!first) return null;
  return {
    ...first,
    apiUrl: toDriveApiMediaUrl(first.id),
    publicUrl: toDrivePublicUrl(first.id),
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 &&
  (module.exports = {
    DERIVATION_KEY_PROPERTY,
    buildDerivationKeyQuery,
    escapeDriveQueryValue,
    findFileByDerivationKey,
    generateDerivationKey,
    getVersionedTransform,
    toDriveApiMediaUrl,
    toDrivePublicUrl,
  });
