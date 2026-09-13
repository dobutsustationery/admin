import { getStoredToken, refreshTokensSilently } from "./google-auth-unified";
import type {
  CustomsInput,
  CustomsSource,
  CustomsReport,
} from "./customs-summary-model";

async function request(
  url: string,
  init: RequestInit = {},
  refresh = true,
): Promise<any> {
  let token = getStoredToken();
  if (!token || token.expires_at <= Date.now()) {
    await refreshTokensSilently();
    token = getStoredToken();
  }
  if (!token) throw new Error("Connect your Google account first.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (response.status === 401 && refresh && (await refreshTokensSilently()))
      return request(url, init, false);
    if (response.ok) return response.json();
    // Only retry reads here: a create timeout must never create a second file.
    if (
      (!init.method || init.method === "GET") &&
      (response.status === 429 || response.status >= 500) &&
      attempt < 3
    ) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      continue;
    }
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `Google ${response.status}: ${body.error?.message || response.statusText}`,
    );
  }
}
export function sheetIdFromUrl(value: string): string {
  const id =
    value.match(
      /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/,
    )?.[1] || value.trim();
  if (!/^[\w-]{10,}$/.test(id))
    throw new Error("Enter a Google Sheets link or spreadsheet ID.");
  return id;
}
export async function listCustomsSheets(): Promise<
  { id: string; name: string }[]
> {
  const files: { id: string; name: string }[] = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({
      q: "mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
      fields: "nextPageToken,files(id,name)",
      pageSize: "100",
      orderBy: "modifiedTime desc",
      ...(pageToken ? { pageToken } : {}),
    });
    const raw = await request(
      `https://www.googleapis.com/drive/v3/files?${query}`,
    );
    files.push(...raw.files);
    pageToken = raw.nextPageToken || "";
  } while (pageToken);
  return files;
}
export async function getCustomsSheet(id: string) {
  const query = new URLSearchParams({
    fields: "spreadsheetId,properties(title,locale,timeZone),sheets.properties",
  });
  return request(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?${query}`,
  );
}
async function metadata(id: string) {
  return request(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,version`,
  );
}
export const a1Tab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
async function source(
  id: string,
  tab: string,
  lastColumn: string,
): Promise<CustomsSource> {
  const before = await metadata(id);
  if (before.mimeType !== "application/vnd.google-apps.spreadsheet")
    throw new Error(
      "Save the Excel file as a native Google Sheet before selecting it.",
    );
  const book = await getCustomsSheet(id);
  const sheet = book.sheets.find(
    (s: any) => s.properties.title === tab,
  )?.properties;
  if (!sheet) throw new Error(`Tab ${tab} was not found in ${before.name}`);
  const rows: any[][] = [];
  // Read all grid rows in bounded requests, preserving physical row addresses.
  for (let start = 1; start <= sheet.gridProperties.rowCount; start += 1000) {
    const end = Math.min(start + 999, sheet.gridProperties.rowCount);
    const range = `${a1Tab(tab)}!A${start}:${lastColumn}${end}`;
    const query = new URLSearchParams({
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "SERIAL_NUMBER",
    });
    const raw = await request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(range)}?${query}`,
    );
    for (let i = 0; i <= end - start; i++) rows.push(raw.values?.[i] || []);
  }
  const after = await metadata(id);
  if (before.version !== after.version)
    throw new Error(
      `${before.name} changed while reading. Read the sources again.`,
    );
  return {
    id,
    name: before.name,
    tab,
    sheetId: sheet.sheetId,
    rows,
    modifiedTime: after.modifiedTime,
  };
}
export async function readCustomsInput(
  orderId: string,
  orderTab: string,
  shippingId: string,
  shippingTab: string,
): Promise<CustomsInput> {
  if (orderId === shippingId)
    throw new Error("Select separate order and shipping spreadsheets.");
  const [order, shipping, book] = await Promise.all([
    source(orderId, orderTab, "AZ"),
    source(shippingId, shippingTab, "AZ"),
    getCustomsSheet(orderId),
  ]);
  const dictionary = book.sheets.some(
    (s: any) => s.properties.title === "HS Codes",
  )
    ? await source(orderId, "HS Codes", "F")
    : undefined;
  await assertCustomsSourcesCurrent({ order, shipping });
  return { order, shipping, ...(dictionary ? { dictionary } : {}) };
}
export async function assertCustomsSourcesCurrent(
  input: CustomsInput,
): Promise<void> {
  for (const s of [
    input.order,
    input.shipping,
    ...(input.dictionary ? [input.dictionary] : []),
  ]) {
    const current = await metadata(s.id);
    if (current.modifiedTime !== s.modifiedTime)
      throw new Error(
        `${s.name} changed since this preview. Read sources again and review the changes.`,
      );
  }
}
export async function createCustomsWorkbook(
  report: CustomsReport,
  runId: string,
): Promise<any> {
  return request("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        title: `Customs Summary — ${report.projection.invoice} — ${runId}`,
      },
      sheets: Object.keys(report.projection.tables).map((title, sheetId) => ({
        properties: { title, sheetId },
      })),
    }),
  });
}
export async function findCustomsExport(runId: string): Promise<any | null> {
  // Run IDs are generated UUIDs; restrict before inserting into a Drive query.
  if (!/^[\w-]+$/.test(runId)) throw new Error("Invalid export run ID");
  const q = new URLSearchParams({
    q: `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and name contains '${runId}'`,
    fields: "files(id,name)",
  });
  const raw = await request(`https://www.googleapis.com/drive/v3/files?${q}`);
  if (raw.files.length > 1)
    throw new Error(
      "Multiple workbooks match this export. Resolve them in Google Drive before retrying.",
    );
  return raw.files.length ? getCustomsSheet(raw.files[0].id) : null;
}
export async function writeCustomsWorkbook(
  id: string,
  report: CustomsReport,
): Promise<any> {
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
  const tables = report.projection.tables;
  // Grow grid bounds first; longer supplier reports can exceed the default 1000 rows.
  await request(`${base}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: Object.entries(tables).map(([, rows], sheetId) => ({
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: {
              rowCount: Math.max(1000, rows.length),
              columnCount: 20,
            },
          },
          fields: "gridProperties.rowCount,gridProperties.columnCount",
        },
      })),
    }),
  });
  // Bounded writes make retries safe and avoid per-row requests.
  for (const [tab, rows] of Object.entries(tables)) {
    for (let start = 0; start < rows.length; start += 500) {
      await request(`${base}/values:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          valueInputOption: "RAW",
          data: [
            {
              range: `${a1Tab(tab)}!A${start + 1}`,
              values: rows.slice(start, start + 500),
            },
          ],
        }),
      });
    }
  }
  await request(`${base}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: Object.keys(tables).flatMap((_, sheetId) => [
        {
          repeatCell: {
            range: { sheetId },
            cell: {
              userEnteredFormat: {
                wrapStrategy: "WRAP",
                verticalAlignment: "TOP",
              },
            },
            fields:
              "userEnteredFormat.wrapStrategy,userEnteredFormat.verticalAlignment",
          },
        },
        {
          updateDimensionProperties: {
            range: {
              sheetId,
              dimension: "COLUMNS",
              startIndex: 0,
              endIndex: 11,
            },
            properties: { pixelSize: 160 },
            fields: "pixelSize",
          },
        },
        ...(sheetId === 0
          ? [
              {
                repeatCell: {
                  range: {
                    sheetId,
                    startColumnIndex: 6,
                    endColumnIndex: 8,
                    startRowIndex: 6,
                    endRowIndex: 7 + report.projection.groups.length,
                  },
                  cell: {
                    userEnteredFormat: {
                      numberFormat: { type: "NUMBER", pattern: "0.000" },
                    },
                  },
                  fields: "userEnteredFormat.numberFormat",
                },
              },
            ]
          : []),
      ]),
    }),
  });
  const query = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE" });
  for (const [tab, rows] of Object.entries(tables))
    query.append("ranges", `${a1Tab(tab)}!A1:K${rows.length}`);
  return request(`${base}/values:batchGet?${query}`);
}
