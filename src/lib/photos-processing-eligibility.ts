function extractDriveFileIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const patterns = [
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /drive\/v3\/files\/([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function isSameImageReference(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  const leftId = extractDriveFileIdFromUrl(left);
  const rightId = extractDriveFileIdFromUrl(right);
  if (leftId && rightId) return leftId === rightId;
  return left === right;
}

export function shouldProcessPhotoFromHistory(input: {
  currentUrl?: string;
  urlHistory?: string[];
}): boolean {
  const history = input.urlHistory || [];
  const currentUrl = input.currentUrl;
  if (!currentUrl) return false;

  // Never processed (or no persisted history): allow.
  if (history.length <= 1) return true;

  // Root/original image is the oldest entry.
  const rootUrl = history[history.length - 1];
  return isSameImageReference(currentUrl, rootUrl);
}
