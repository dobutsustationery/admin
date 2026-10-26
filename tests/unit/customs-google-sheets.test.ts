import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCustomsWorkbook,
  writeCustomsWorkbook,
  sheetIdFromUrl,
  readCustomsInput,
} from "$lib/google-sheets";
import {
  reduceCustoms,
  customsCreated,
  customsSourceChunk,
  customsSourceReceived,
  customsDecision,
  customsSettings,
} from "$lib/customs-summary-slice";
import fixture from "../fixtures/customs-august.json";

vi.mock("$lib/google-auth-unified", () => ({
  getStoredToken: () => ({
    access_token: "test-only",
    expires_at: Number.MAX_SAFE_INTEGER,
  }),
  refreshTokensSilently: async () => false,
}));
afterEach(() => {
  vi.unstubAllGlobals();
});
function readyReport() {
  const actions = [
    customsCreated({ reportId: "r", name: "test" }),
    customsSourceChunk({
      reportId: "r",
      readId: "i",
      index: 0,
      json: JSON.stringify(fixture),
    }),
    customsSourceReceived({ reportId: "r", readId: "i", chunks: 1 }),
    customsDecision({
      reportId: "r",
      jans: fixture.order.rows.slice(10, 79).map((r) => String(r[2])),
      decision: { code: "48201030" },
    }),
    customsSettings({
      reportId: "r",
      settings: {
        grossKg: "33",
        grossSource: "test",
        grossMethod: "shipment" as const,
        cartonGross: {},
        packagePolicy: "cartons" as const,
      },
    }),
  ];
  return actions.reduce((s, a) => reduceCustoms(s, a, {}), undefined as any)
    .reports.r;
}
describe("customs Sheets transport", () => {
  it("writes the exact reducer tables as RAW values and never changes sharing or sources", async () => {
    const calls: { url: string; body: any }[] = [];
    const report = readyReport();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const body = JSON.parse(String(init.body || "{}"));
        calls.push({ url, body });
        return {
          ok: true,
          json: async () =>
            url.endsWith("/v4/spreadsheets")
              ? { spreadsheetId: "new-output" }
              : url.includes("values:batchGet")
                ? {
                    valueRanges: Object.values(report.projection.tables).map(
                      (values) => ({ values }),
                    ),
                  }
                : {},
        };
      }),
    );
    await createCustomsWorkbook(report, "run-id");
    const readback = await writeCustomsWorkbook("new-output", report);
    expect(readback.valueRanges[0].values).toEqual(
      report.projection.tables["Ognyan Summary"],
    );
    const writes = calls.filter((c) => c.url.includes("values:batchUpdate"));
    expect(writes).toHaveLength(4);
    expect(writes[0].body).toMatchObject({
      valueInputOption: "RAW",
      data: [{ values: report.projection.tables["Ognyan Summary"] }],
    });
    expect(
      calls.some(
        (c) =>
          c.url.includes("permissions") ||
          c.url.includes("order-fixture") ||
          c.url.includes("shipping-fixture"),
      ),
    ).toBe(false);
  });
  it("does not automatically retry uncertain workbook creation", async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: { message: "uncertain" } }),
    }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      createCustomsWorkbook(readyReport(), "run-id"),
    ).rejects.toThrow("Google 503");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects non-Sheets URLs and selecting the same source tab twice", async () => {
    expect(
      sheetIdFromUrl(
        "https://docs.google.com/spreadsheets/d/abcdefghijk/edit#gid=1",
      ),
    ).toBe("abcdefghijk");
    expect(() => sheetIdFromUrl("https://example.com/private")).toThrow();
    await expect(
      readCustomsInput("same", "Product List", "same", "Product List"),
    ).rejects.toThrow("different tabs");
  });
  it("reads separate order and shipping tabs from one workbook", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const u = new URL(url);
        let body: any;
        if (u.hostname === "www.googleapis.com") {
          body = {
            id: "shared-workbook",
            name: "Combined supplier workbook",
            mimeType: "application/vnd.google-apps.spreadsheet",
            version: "1",
            modifiedTime: "2026-10-13T12:00:00Z",
          };
        } else if (u.pathname.includes("/values/")) {
          body = {
            values: [
              [
                decodeURIComponent(u.pathname.split("/values/")[1]).startsWith(
                  "'Order'",
                )
                  ? "order row"
                  : "shipping row",
              ],
            ],
          };
        } else {
          body = {
            sheets: [
              {
                properties: {
                  title: "Order",
                  sheetId: 1,
                  gridProperties: { rowCount: 1 },
                },
              },
              {
                properties: {
                  title: "Shipping",
                  sheetId: 2,
                  gridProperties: { rowCount: 1 },
                },
              },
            ],
          };
        }
        return { ok: true, json: async () => body };
      }),
    );
    const input = await readCustomsInput(
      "shared-workbook",
      "Order",
      "shared-workbook",
      "Shipping",
    );
    expect(input.order.id).toBe(input.shipping.id);
    expect(input.order.sheetId).toBe(1);
    expect(input.shipping.sheetId).toBe(2);
    expect(input.order.rows).toEqual([["order row"]]);
    expect(input.shipping.rows).toEqual([["shipping row"]]);
    expect(calls.filter((url) => url.includes("/values/"))).toHaveLength(2);
  });
});
