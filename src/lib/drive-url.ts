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
