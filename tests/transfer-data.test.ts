import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
    
    expect(content).toContain('COMMAND_EXPORT');
    expect(content).toContain('COMMAND_IMPORT');
    expect(content).toContain('COMMAND_TRANSFER');
  });

  it("script has export and import functions", () => {
    const scriptPath = resolve(process.cwd(), "scripts/transfer-data.js");
    const content = readFileSync(scriptPath, "utf8");
    
    expect(content).toContain("async function exportData");
    expect(content).toContain("async function importData");
  });
});
