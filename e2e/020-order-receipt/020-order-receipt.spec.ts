import { test, expect } from "../fixtures/auth";
import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("receiving survives reload and posts stock and company assets once", async ({
  page,
  authenticatedPage,
}, testInfo) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const stamp = Date.now();
  const reportId = "receipt-browser-" + stamp;
  const raw = JSON.parse(
    readFileSync(
      new URL("../../tests/fixtures/customs-august.json", import.meta.url),
      "utf8",
    ),
  );
  const jans = raw.order.rows.slice(10, 79).map((r: any[]) => String(r[2]));
  const replacements = new Map(
    jans.map((jan: string, i: number) => [
      jan,
      String(8000000000000 + (stamp % 10000000) * 100 + i),
    ]),
  );
  for (const source of [raw.order, raw.shipping, raw.dictionary].filter(
    Boolean,
  )) {
    source.rows = source.rows.map((row: any[]) =>
      row.map((v) => replacements.get(String(v)) || v),
    );
    source.id = source.id + "-" + stamp;
  }
  const first = String(raw.order.rows[10][2]);
  const firstQty = Number(raw.order.rows[10][3]);
  const admin = initializeApp(
    { projectId: "demo-test-project" },
    "receipt-test-" + stamp,
  );
  const db = getFirestore(admin);
  db.settings({
    host: "127.0.0.1:" + (process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"),
    ssl: false,
  });
  const events = [
    {
      type: "customs/created",
      payload: { reportId, name: "Browser receipt " + stamp },
    },
    {
      type: "customs/sourceChunk",
      payload: {
        reportId,
        readId: "source",
        index: 0,
        json: JSON.stringify(raw),
      },
    },
    {
      type: "customs/sourceReceived",
      payload: { reportId, readId: "source", chunks: 1 },
    },
    {
      type: "customs/decision",
      payload: {
        reportId,
        jans: [...replacements.values()],
        decision: { code: "48201030" },
      },
    },
  ];
  const batch = db.batch();
  events.forEach((event, i) =>
    batch.set(db.collection("broadcast").doc(reportId + "-" + i), {
      ...event,
      creator: "receipt-browser-test",
      timestamp: Timestamp.fromMillis(stamp + i),
    }),
  );
  await batch.commit();
  await db.terminate();
  await deleteApp(admin);
  await page.goto("/order-receipt?reportId=" + reportId);
  await page
    .getByRole("button", { name: "Start receiving", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Count and inspect", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Complete receipt and post accepted goods",
      exact: true,
    }),
  ).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Select all 69 unreviewed, unambiguous rows shown",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", {
      name: "Confirm 69 selected counts and quality correct",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Review " + first, exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Destination", exact: true })
    .selectOption("asset");
  await page
    .getByLabel("Discrepancy / destination note", { exact: true })
    .fill("Company stationery");
  await page
    .getByRole("button", { name: "Save inspected line", exact: true })
    .click();
  await page.getByLabel("Receipt date", { exact: true }).fill("2026-10-04");
  await page.getByLabel("Invoice total JPY", { exact: true }).fill("250000");
  await page.getByLabel("Actual paid amount", { exact: true }).fill("1500");
  await page
    .getByLabel("Shipping cost (zero if none)", { exact: true })
    .fill("11770");
  await page
    .getByLabel(
      "I checked that source pieces match the inventory selling units.",
      { exact: true },
    )
    .check();
  await page
    .getByLabel(
      "I checked the history: this delivery has not already been added to inventory.",
      { exact: true },
    )
    .check();
  await page
    .getByRole("button", {
      name: "Save receipt and payment details",
      exact: true,
    })
    .click();
  const complete = page.getByRole("button", {
    name: "Complete receipt and post accepted goods",
    exact: true,
  });
  await expect(complete).toBeEnabled();
  await page.reload();
  await expect(complete).toBeEnabled();
  await page
    .getByRole("heading", { name: "Acceptance preview", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("receipt-preview.png"),
    fullPage: false,
  });
  await complete.click();
  await expect(
    page.getByRole("heading", { name: "Receipt completed", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".complete")).toContainText(
    911 - firstQty + " units added to inventory",
  );
  const posted = await page.evaluate((jan) => {
    const state = (window as any).store.getState();
    return !!state.inventory.idToItem[jan];
  }, first);
  expect(posted).toBe(false);
  await expect(
    page.getByRole("heading", {
      name: "Company-use acceptance register",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Receipt completed", exact: true }),
  ).toBeVisible();
  await expect(complete).toHaveCount(0);
});
