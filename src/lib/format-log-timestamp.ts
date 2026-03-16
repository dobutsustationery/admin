function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatLogTimestamp(timestampMs: number): string {
  const d = new Date(timestampMs);
  const now = new Date();

  const timePart = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

  const isSameYear = d.getFullYear() === now.getFullYear();
  const isSameMonth = d.getMonth() === now.getMonth();
  const isSameDay = d.getDate() === now.getDate();
  const isToday = isSameYear && isSameMonth && isSameDay;

  if (isToday) return timePart;

  const monthDay = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });

  if (isSameYear) return `${monthDay} ${timePart}`;
  return `${monthDay}, ${d.getFullYear()} ${timePart}`;
}
