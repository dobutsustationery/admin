export type ImageSize = "thumbnail" | "preview" | "full";

export const SIZE_SUFFIXES: Record<ImageSize, string> = {
  thumbnail: "=s200",
  preview: "=s800",
  full: "=s0",
};

/**
 * Strip the trailing Google image size suffix (e.g. =s200, =w400-h300-c, =d)
 * from a googleusercontent.com URL.
 */
export function stripGoogleSizeSuffix(url: string): string {
  return url.replace(/=[a-z0-9,-]+$/i, "");
}

/**
 * Replace any existing Google size suffix on a googleusercontent.com URL with
 * the suffix appropriate for the requested ImageSize.  Non-Google URLs are
 * returned unchanged.
 */
export function applyGoogleSizeSuffix(url: string, size: ImageSize): string {
  if (!url.includes("googleusercontent.com") && !url.includes("lh3.google")) {
    return url;
  }
  return stripGoogleSizeSuffix(url) + SIZE_SUFFIXES[size];
}

export function extractGoogleDriveFileId(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) return value;

  const apiMatch = value.match(/\/drive\/v3\/files\/([a-zA-Z0-9_-]+)/);
  if (apiMatch?.[1]) return apiMatch[1];

  const pathMatch = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const lh3PathMatch = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (lh3PathMatch?.[1]) return lh3PathMatch[1];

  const idMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch?.[1]) return idMatch[1];

  return "";
}

export function toGoogleDrivePublicImageUrl(rawUrl: string): string {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  const fileId = extractGoogleDriveFileId(value);
  if (!fileId) return value;
  return `https://lh3.googleusercontent.com/d/${fileId}=s0`;
}
