// A shared JAN is eligible when any inventory variant has stock on hand.
export function scanInventoryJans(
  items: Record<
    string,
    { janCode?: unknown; qty?: unknown; shipped?: unknown }
  >,
  includeZeroStock = false,
): string[] {
  return [
    ...new Set(
      Object.values(items)
        .filter(
          (item) =>
            includeZeroStock ||
            Number(item.qty || 0) - Number(item.shipped || 0) > 0,
        )
        .map((item) => String(item.janCode || "").trim())
        .filter((jan) => /^\d{13}$/.test(jan)),
    ),
  ];
}
