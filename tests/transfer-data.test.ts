import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("data transfer script", () => {
  it("script file exists and is readable", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content).toBeTruthy();
    expect(content.length).toBeGreaterThan(0);
  });

  it("script has proper shebang", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("script imports required firebase-admin modules", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content).toContain("firebase-admin/app");
    expect(content).toContain("firebase-admin/firestore");
  });

  it("script defines expected command types", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content).toContain("COMMAND_EXPORT");
    expect(content).toContain("COMMAND_IMPORT");
    expect(content).toContain("COMMAND_TRANSFER");
  });

  it("script has export and import functions", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content).toContain("async function exportData");
    expect(content).toContain("async function importData");
  });

  it("script supports append imports by timestamp or createdAtMs", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");

    expect(content).toContain("append: options.append === true");
    expect(content).toContain("async function selectAppendDocuments");
    expect(content).toContain("APPEND_CURSOR_FIELDS");
    expect(content).toContain('name: "timestamp"');
    expect(content).toContain('name: "createdAtMs"');
    expect(content).toContain("async function getCollectionCount");
    expect(content).toContain("collectionRef.count().get()");
    expect(content).toContain("async function selectMissingAppendDocuments");
    expect(content).toContain("db.getAll(...docRefs)");
  });
});
