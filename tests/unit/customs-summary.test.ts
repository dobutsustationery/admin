import { describe, it, expect } from "vitest";
import fixture from "../fixtures/customs-august.json";
import { rootReducer } from "$lib/root-reducer";
import {
  customsCreated,
  customsRenamed,
  customsAbandonmentChanged,
  customsSourceChunk,
  customsSourceReceived,
  customsDecision,
  customsSettings,
  customsExportStarted,
  customsExportResponse,
  customsExportReadback,
} from "$lib/customs-summary-slice";
import type { CustomsInput } from "$lib/customs-summary-model";

const reportId = "customs-test";
const input = () => structuredClone(fixture) as CustomsInput;
const factEvents = (raw = input()) => [
  customsCreated({ reportId, name: "Test shipment" }),
  customsSourceChunk({
    reportId,
    readId: "read1",
    index: 0,
    json: JSON.stringify(raw),
  }),
  customsSourceReceived({ reportId, readId: "read1", chunks: 1 }),
];
function replay(actions: any[], initial?: any) {
  return actions.reduce(
    (s, a, i) =>
      rootReducer(
        s,
        {
          ...a,
          id: `event-${i}`,
          creator: "test-user",
          timestamp: { seconds: 1700000000 + i, nanoseconds: 0 },
        },
        () => {},
      ),
    initial,
  );
}
const report = (s: any) => s.customsSummary.reports[reportId];
function readyEvents() {
  // Synthetic classifications and measured gross are test inputs, not claims
  // about the actual supplier products or shipment gross.
  const jans = fixture.order.rows.slice(10, 79).map((r) => String(r[2]));
  return [
    ...factEvents(),
    customsDecision({ reportId, jans, decision: { code: "48201030" } }),
    customsSettings({
      reportId,
      settings: {
        grossKg: "33",
        grossSource: "Synthetic test measurement",
        grossMethod: "shipment",
        cartonGross: {},
        packagePolicy: "cartons",
      },
    }),
  ];
}
describe("customs report event replay", () => {
  it("replays names and abandonment without losing calculations or export history", () => {
    const initial = replay([
      ...readyEvents(),
      customsExportStarted({ reportId, runId: "saved" }),
    ]);
    const before = report(initial);
    const events = [
      customsRenamed({ reportId, name: "  September shipment  " }),
      customsRenamed({ reportId, name: "   " }),
      customsAbandonmentChanged({ reportId, abandoned: true }),
      customsDecision({
        reportId,
        jans: ["test"],
        decision: { code: "12345678" },
      }),
      customsExportStarted({ reportId, runId: "blocked" }),
      customsExportResponse({
        reportId,
        runId: "saved",
        json: '{"spreadsheetId":"existing"}',
      }),
    ];
    const abandoned = report(replay(events, initial));
    expect(abandoned.name).toBe("September shipment");
    expect(abandoned.abandoned).toBe(true);
    expect(abandoned.revision).toBe(before.revision);
    expect(abandoned.projection).toEqual(before.projection);
    expect(abandoned.decisions).toEqual(before.decisions);
    expect(abandoned.exports.blocked).toBeUndefined();
    expect(abandoned.exports.saved.response).toContain("existing");
    const restored = report(
      replay(
        [customsAbandonmentChanged({ reportId, abandoned: false })],
        replay(events, initial),
      ),
    );
    expect(restored).toEqual({ ...abandoned, abandoned: false });
    expect(
      report(
        replay([
          ...readyEvents(),
          customsExportStarted({ reportId, runId: "saved" }),
          ...events,
        ]),
      ),
    ).toEqual(abandoned);
  });

  it("offers earlier accepted classifications as suggestions, never silent acceptance", () => {
    const first = replay(readyEvents());
    const next = replay(
      factEvents().map((a) => ({
        ...a,
        payload: { ...a.payload, reportId: "second-report" },
      })),
      first,
    );
    const p = next.customsSummary.reports["second-report"].projection;
    expect(p.products[0].code).toBe("");
    expect(p.products[0].suggestions[0].reason).toContain(
      "Previously accepted",
    );
    expect(p.products[0].suggestions[0].code).toBe("48201030");
  });
  it("keeps origin groups distinct, allocates every carton and conserves rounded gross", () => {
    const first = replay(readyEvents());
    const jan = report(first).projection.products[0].jan;
    const next = replay(
      [
        customsDecision({
          reportId,
          jans: [jan],
          decision: { origin: "China" },
        }),
        customsSettings({
          reportId,
          settings: {
            grossKg: "",
            grossSource: "Synthetic per-carton measurements",
            grossMethod: "carton",
            cartonGross: { "1": "10", "2": "15", "3": "8" },
            packagePolicy: "cartons",
          },
        }),
      ],
      first,
    );
    const p = report(next).projection;
    expect(p.ready).toBe(true);
    expect(p.groups).toHaveLength(2);
    expect(
      p.groups.reduce(
        (n: number, g: any) => n + Math.round(g.grossKg * 1000),
        0,
      ),
    ).toBe(33000);
    expect(
      p.groups.reduce((n: number, g: any) => n + g.cartons.length, 0),
    ).toBe(4);
    expect(p.cartons).toHaveLength(3);
  });
  it("blocks a changed supplier footer instead of silently ignoring a disagreement", () => {
    const raw = input();
    raw.order.rows[88][7] = "999999";
    const p = report(replay(factEvents(raw))).projection;
    expect(p.issues.some((s: string) => s.includes("totals row 89"))).toBe(
      true,
    );
  });
  it("discards an old cached calculation schema and replays the original facts", () => {
    const poisoned = structuredClone(replay(readyEvents()));
    poisoned.schemaVersion = 20;
    report(poisoned).projection.totals.yen = -999;
    const initial = rootReducer(undefined, { type: "@@INIT" }, () => {});
    const hydrated = rootReducer(
      initial,
      { type: "HYDRATE", payload: poisoned },
      () => {},
    );
    expect(hydrated.customsSummary.reports).toEqual({});
    expect(report(replay(readyEvents(), hydrated)).projection.totals.yen).toBe(
      238230,
    );
  });
  it("reconciles the actual August inputs and excludes order/footer totals", () => {
    const p = report(replay(factEvents())).projection;
    expect(p.products).toHaveLength(69);
    expect(p.allocations).toHaveLength(69);
    expect(p.totals).toEqual({
      pieces: 911,
      yen: 238230,
      netKg: 29.45,
      grossKg: null,
    });
    expect(
      p.cartons.map((c: any) => [
        c.id,
        c.pieces,
        c.yen,
        Number(c.netKg.toFixed(3)),
      ]),
    ).toEqual([
      ["1", 371, 108520, 8.72],
      ["2", 230, 55580, 13.37],
      ["3", 310, 74130, 7.36],
    ]);
    expect(
      p.issues.filter(
        (s: string) =>
          !s.includes("HS code") &&
          !s.includes("gross") &&
          !s.includes("package"),
      ),
    ).toEqual([]);
    expect(p.ready).toBe(false);
    expect(p.products.some((v: any) => v.suggestions.length)).toBe(true);
    expect(p.products.every((v: any) => !v.code)).toBe(true);
  });
  it("accepts decisions, derives both tables and rebuilds correctly without saved calculations", () => {
    const events = readyEvents();
    const first = replay(events);
    const p = report(first).projection;
    expect(p.issues).toEqual([]);
    expect(p.ready).toBe(true);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({
      pieces: 911,
      yen: 238230,
      netKg: 29.45,
      grossKg: 33,
      cartons: ["1", "2", "3"],
      bg: "тетрадки и бележници",
    });
    expect(p.tables["Ognyan Summary"][6]).toEqual([
      "48201030",
      "Notebooks & Memo Pads",
      "тетрадки и бележници",
      "Japan",
      911,
      3,
      29.45,
      33,
      238230,
    ]);
    const broken = structuredClone(first);
    report(broken).projection.totals.yen = -999;
    expect(report(replay(events)).projection).toEqual(p);
    expect(JSON.stringify(events)).not.toMatch(
      /"projection"|"groups"|"netKg"|"lineGoodsJpy"/,
    );
  });
  it("does not mutate inventory or listing/sync state", () => {
    const before = rootReducer(undefined, { type: "@@INIT" }, () => {});
    const after = replay(readyEvents(), before);
    for (const key of [
      "inventory",
      "listings",
      "shopifySync",
      "amazonCatalog",
      "syncQueue",
      "orderImport",
    ])
      expect(after[key]).toEqual(before[key]);
  });
  it("keeps source chunks durable and cannot commit an incomplete read", () => {
    const json = JSON.stringify(input()),
      split = Math.floor(json.length / 2);
    let state = replay([
      customsCreated({ reportId, name: "Test" }),
      customsSourceChunk({
        reportId,
        readId: "r",
        index: 0,
        json: json.slice(0, split),
      }),
      customsSourceReceived({ reportId, readId: "r", chunks: 2 }),
    ]);
    expect(report(state).input).toBeUndefined();
    state = replay(
      [
        customsSourceChunk({
          reportId,
          readId: "r",
          index: 1,
          json: json.slice(split),
        }),
        customsSourceReceived({ reportId, readId: "r", chunks: 2 }),
      ],
      state,
    );
    expect(report(state).projection.totals.pieces).toBe(911);
  });
  it("split cartons consume the ordered value once and sort naturally", () => {
    const raw = input();
    raw.shipping.rows[10][3] = "7";
    raw.shipping.rows[10][4] = "10";
    const second = [...raw.shipping.rows[10]];
    second[3] = "13";
    second[4] = "2";
    raw.shipping.rows.push(second);
    const p = report(replay(factEvents(raw))).projection;
    const rows = p.allocations.filter((a: any) => a.jan === "4952270242559");
    expect(rows.map((a: any) => a.qty)).toEqual([7, 13]);
    expect(rows.reduce((n: number, a: any) => n + a.yen, 0)).toBe(4240);
    expect(p.totals.yen).toBe(238230);
    expect(p.groups[0].cartons).toEqual(["1", "2", "3", "10"]);
  });
  it("requires explicit manual classification when suggestions are absent; selected overrides affect only selected JANs", () => {
    let s = replay(factEvents());
    const jan = report(s).projection.products[0].jan;
    s = replay(
      [
        customsDecision({
          reportId,
          jans: [jan],
          decision: { code: "12345678", en: "Manual test", bg: "Ръчно" },
        }),
      ],
      s,
    );
    expect(
      report(s).projection.products.filter((v: any) => v.code),
    ).toHaveLength(1);
    expect(report(s).projection.ready).toBe(false);
  });
  it("blocks mismatched quantities, duplicate rows and impossible gross", () => {
    const raw = input();
    raw.shipping.rows[10][3] = "21";
    raw.shipping.rows.push([...raw.shipping.rows[11]]);
    const p = report(replay(factEvents(raw))).projection;
    expect(
      p.issues.some((v: string) => v.includes("ordered 20, shipped 21")),
    ).toBe(true);
    expect(
      p.issues.some((v: string) => v.includes("duplicate allocation")),
    ).toBe(true);
    const s = replay([
      ...readyEvents(),
      customsSettings({
        reportId,
        settings: {
          grossKg: "1",
          grossSource: "test",
          grossMethod: "shipment",
          cartonGross: {},
          packagePolicy: "cartons",
        },
      }),
    ]);
    expect(report(s).projection.totals.grossKg).toBe(null);
    expect(report(s).projection.ready).toBe(false);
  });
  it("invalidates decisions when source facts change and reuses reducer-time inventory facts", () => {
    const raw = input();
    raw.order.rows[10][4] = "Different product";
    let s = replay(readyEvents());
    s = replay(
      [
        customsSourceChunk({
          reportId,
          readId: "new",
          index: 0,
          json: JSON.stringify(raw),
        }),
        customsSourceReceived({ reportId, readId: "new", chunks: 1 }),
      ],
      s,
    );
    expect(report(s).decisions).toEqual({});
    expect(report(s).projection.ready).toBe(false);
  });
  it("verifies raw Google readback against reducer-generated preview and rejects an older revision", () => {
    let s = replay(readyEvents());
    const p = report(s).projection;
    s = replay(
      [
        customsExportStarted({ reportId, runId: "run1" }),
        customsExportResponse({
          reportId,
          runId: "run1",
          json: JSON.stringify({ spreadsheetId: "google-result" }),
        }),
        customsExportReadback({
          reportId,
          runId: "run1",
          json: JSON.stringify({
            valueRanges: Object.values(p.tables).map((values) => ({ values })),
          }),
        }),
      ],
      s,
    );
    expect(report(s).exports.run1.verified).toBe(true);
    s = replay(
      [
        customsDecision({
          reportId,
          jans: [p.products[0].jan],
          decision: { code: "48211010" },
        }),
        customsExportReadback({
          reportId,
          runId: "run1",
          json: JSON.stringify({
            valueRanges: Object.values(p.tables).map((values) => ({ values })),
          }),
        }),
      ],
      s,
    );
    expect(report(s).exports.run1.verified).toBe(false);
  });
});
