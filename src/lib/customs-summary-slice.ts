import { createAction } from "@reduxjs/toolkit";
import { computeCustoms } from "./customs-summary-compute";
import type {
  CustomsDecision,
  CustomsReport,
  CustomsSettings,
  CustomsState,
} from "./customs-summary-model";

// These actions contain only incoming source bytes, operator inputs, and raw
// external responses. No parsed rows, suggestions, matches or totals are events.
export const customsCreated = createAction<{ reportId: string; name: string }>(
  "customs/created",
);
export const customsSourceChunk = createAction<{
  reportId: string;
  readId: string;
  index: number;
  json: string;
}>("customs/sourceChunk");
export const customsSourceReceived = createAction<{
  reportId: string;
  readId: string;
  chunks: number;
}>("customs/sourceReceived");
export const customsDecision = createAction<{
  reportId: string;
  jans: string[];
  decision: CustomsDecision;
}>("customs/decision");
export const customsSettings = createAction<{
  reportId: string;
  settings: CustomsSettings;
}>("customs/settings");
export const customsExportStarted = createAction<{
  reportId: string;
  runId: string;
}>("customs/exportStarted");
export const customsExportResponse = createAction<{
  reportId: string;
  runId: string;
  json: string;
}>("customs/exportResponse");
export const customsExportReadback = createAction<{
  reportId: string;
  runId: string;
  json: string;
}>("customs/exportReadback");

export const initialCustomsState: CustomsState = {
  reports: {},
  appliedEventIds: [],
};
export function customsSummary(
  state: CustomsState = initialCustomsState,
): CustomsState {
  return state;
}

function applyCustoms(
  state: CustomsState = initialCustomsState,
  action: any,
  inventory: Record<string, any>,
): CustomsState {
  if (!action.type.startsWith("customs/")) return state;
  const payload = action.payload;
  if (!payload?.reportId) return state;
  let report: CustomsReport;
  const existing = state.reports[payload.reportId];
  if (customsCreated.match(action)) {
    if (existing) return state;
    report = {
      id: payload.reportId,
      name: payload.name,
      creator: (action as any).creator || "",
      timestamp: (action as any)._timestamp || 0,
      chunks: {},
      inventoryFacts: {},
      previousClassifications: [],
      settingsConfirmed: false,
      decisions: {},
      revision: 0,
      exports: {},
      settings: {
        grossKg: "",
        grossSource: "",
        packagePolicy: "",
        cartonGross: {},
        grossMethod: "shipment",
      },
      projection: null as any,
    };
  } else {
    if (!existing) return state;
    report = { ...existing };
    if (customsSourceChunk.match(action)) {
      report.chunks = {
        ...report.chunks,
        [payload.readId]: {
          ...report.chunks[payload.readId],
          [payload.index]: payload.json,
        },
      };
      return { ...state, reports: { ...state.reports, [report.id]: report } };
    } else if (customsSourceReceived.match(action)) {
      const chunks = report.chunks[payload.readId] || {};
      if (
        !Number.isInteger(payload.chunks) ||
        payload.chunks < 1 ||
        Array.from({ length: payload.chunks }, (_, i) => chunks[i]).some(
          (s) => typeof s !== "string",
        )
      )
        return state;
      try {
        const input = JSON.parse(
          Array.from({ length: payload.chunks }, (_, i) => chunks[i]).join(""),
        );
        if (
          !Array.isArray(input.order?.rows) ||
          !Array.isArray(input.shipping?.rows)
        )
          return state;
        // Keep choices only when the original source product data is identical.
        // A refreshed source is a new review; measurements are retained as inputs.
        if (JSON.stringify(report.input) !== JSON.stringify(input)) {
          report.decisions = {};
          report.settingsConfirmed = false;
        }
        report.input = input;
        report.previousClassifications = Object.values(state.reports).flatMap(
          (prior) =>
            prior.projection.products
              .filter(
                (p) => prior.decisions[p.jan]?.code && p.code && p.en && p.bg,
              )
              .map((p) => ({
                jan: p.jan,
                description: p.description,
                material: p.material,
                code: p.code,
                en: p.en,
                bg: p.bg,
                reportName: prior.name,
              })),
        );
        report.inventoryFacts = Object.fromEntries(
          Object.entries(inventory).map(([key, v]) => [
            key,
            {
              janCode: v.janCode || "",
              hsCode: v.hsCode || "",
              description: v.description || "",
            },
          ]),
        );
        report.chunks = {};
      } catch {
        return state;
      }
      report.revision++;
    } else if (customsDecision.match(action)) {
      report.decisions = { ...report.decisions };
      for (const jan of payload.jans)
        report.decisions[jan] = {
          ...report.decisions[jan],
          ...payload.decision,
        };
      report.revision++;
    } else if (customsSettings.match(action)) {
      report.settings = payload.settings;
      report.settingsConfirmed = true;
      report.revision++;
    } else if (customsExportStarted.match(action)) {
      if (!report.projection.ready || report.exports[payload.runId])
        return state;
      report.exports = {
        ...report.exports,
        [payload.runId]: { revision: report.revision },
      };
      return { ...state, reports: { ...state.reports, [report.id]: report } };
    } else if (customsExportResponse.match(action)) {
      const run = report.exports[payload.runId];
      if (!run) return state;
      report.exports = {
        ...report.exports,
        [payload.runId]: { ...run, response: payload.json },
      };
      return { ...state, reports: { ...state.reports, [report.id]: report } };
    } else if (customsExportReadback.match(action)) {
      const run = report.exports[payload.runId];
      if (!run) return state;
      try {
        const raw = JSON.parse(payload.json);
        const clean = (rows: any[][]) =>
          rows.map((r) => {
            const copy = [...r];
            while (copy.length && (copy.at(-1) === "" || copy.at(-1) === null))
              copy.pop();
            return copy;
          });
        const names = Object.keys(report.projection.tables);
        const verified =
          run.revision === report.revision &&
          raw.valueRanges?.length === names.length &&
          names.every(
            (name, i) =>
              JSON.stringify(clean(raw.valueRanges[i].values || [])) ===
              JSON.stringify(clean(report.projection.tables[name])),
          );
        report.exports = {
          ...report.exports,
          [payload.runId]: { ...run, verified },
        };
      } catch {
        return state;
      }
      return { ...state, reports: { ...state.reports, [report.id]: report } };
    } else return state;
  }
  report.projection = computeCustoms(report);
  return { ...state, reports: { ...state.reports, [report.id]: report } };
}

export function reduceCustoms(
  state: CustomsState = initialCustomsState,
  action: any,
  inventory: Record<string, any>,
): CustomsState {
  const next = applyCustoms(state, action, inventory);
  if (!action.id) return next;
  return {
    ...next,
    appliedEventIds: [
      ...(next.appliedEventIds || []).filter((id) => id !== action.id),
      action.id,
    ].slice(-1000),
  };
}
