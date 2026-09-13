import { test, expect } from "../fixtures/auth";
import { readFileSync } from "node:fs";
import type { CustomsInput } from "../../src/lib/customs-summary-model";
const fixture = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/customs-august.json", import.meta.url),
    "utf8",
  ),
) as CustomsInput;

test("customs source facts survive reload, reviewed classifications preview and export", async ({
  page,
  authenticatedPage,
}, testInfo) => {
  test.setTimeout(90000);
  void authenticatedPage;
  const reportName = `Durable customs browser test ${Date.now()}`;
  const sources = {
    "order-fixture": fixture.order,
    "shipping-fixture": fixture.shipping,
  };
  const exported: Record<string, unknown[][]> = {};
  let creates = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      "google_photos_access_token",
      JSON.stringify({
        access_token: "mock-google-token",
        expires_at: Date.now() + 3600000,
        expires_in: 3600,
        scope:
          "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
        token_type: "Bearer",
      }),
    );
  });
  await page.route("https://www.googleapis.com/drive/v3/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/files"))
      return route.fulfill({
        json: {
          files: [
            ...Object.entries(sources).map(([id, s]) => ({
              id,
              name: s.name,
            })),
            { id: "duplicate-order", name: fixture.order.name },
          ],
        },
      });
    const id = url.pathname.split("/").at(-1)!;
    return route.fulfill({
      json: {
        id,
        name: sources[id as keyof typeof sources]?.name,
        mimeType: "application/vnd.google-apps.spreadsheet",
        modifiedTime: "2026-08-21T10:00:00Z",
        version: "1",
      },
    });
  });
  await page.route("https://sheets.googleapis.com/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (method === "POST" && url.pathname.endsWith("/spreadsheets")) {
      creates++;
      return route.fulfill({ json: { spreadsheetId: "output-fixture" } });
    }
    if (url.pathname.endsWith("values:batchUpdate")) {
      for (const d of route.request().postDataJSON().data)
        exported[d.range.split("!")[0]] = d.values;
      return route.fulfill({ json: {} });
    }
    if (url.pathname.endsWith("values:batchGet"))
      return route.fulfill({
        json: {
          valueRanges: url.searchParams
            .getAll("ranges")
            .map((range) => ({ range, values: exported[range.split("!")[0]] })),
        },
      });
    if (method === "POST") return route.fulfill({ json: {} });
    const id = url.pathname.split("/")[3];
    const s = sources[id as keyof typeof sources];
    if (url.pathname.includes("/values/")) {
      const range = decodeURIComponent(url.pathname.split("/values/")[1]);
      const rows = range.includes("HS Codes")
        ? fixture.dictionary!.rows
        : s.rows;
      const match = range.match(/!A(\d+):[A-Z]+(\d+)$/)!;
      return route.fulfill({
        json: { values: rows.slice(Number(match[1]) - 1, Number(match[2])) },
      });
    }
    return route.fulfill({
      json: {
        spreadsheetId: id,
        sheets: [s.tab, ...(id === "order-fixture" ? ["HS Codes"] : [])].map(
          (title, sheetId) => ({
            properties: {
              title,
              sheetId,
              gridProperties: { rowCount: title === "HS Codes" ? 25 : 1000 },
            },
          }),
        ),
      },
    });
  });
  await page.goto("/customs-summary");
  await expect(
    page.getByRole("button", { name: "Start new report" }),
  ).toBeEnabled({ timeout: 30000 });
  await page.getByLabel("New report name").fill(reportName);
  await page.getByRole("button", { name: "Start new report" }).click();
  await expect(page.getByRole("heading", { name: reportName })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Order spreadsheet", exact: true })
    .fill(fixture.order.name + " — order-fixture");
  await expect(
    page.getByRole("combobox", { name: "Order tab", exact: true }),
  ).toHaveValue("Product List");
  await page
    .getByRole("combobox", { name: "Shipping spreadsheet", exact: true })
    .fill(fixture.shipping.name);
  const orderPicker = page.getByRole("combobox", {
    name: "Order spreadsheet",
    exact: true,
  });
  await expect(
    page.getByLabel("Or order URL / ID", { exact: true }),
  ).toHaveValue("order-fixture");
  await expect(
    page.locator("#customs-order-spreadsheet-files option"),
  ).toHaveCount(3);
  await orderPicker.fill("unmatched partial search");
  await expect(orderPicker).toHaveValue("unmatched partial search");
  await expect(
    page.getByLabel("Or order URL / ID", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Read and reconcile sources" }),
  ).toBeDisabled();
  await orderPicker.fill(fixture.order.name + " — order-fixture");
  await page
    .getByRole("button", { name: "Read and reconcile sources" })
    .click();
  await expect(page.getByText(/911 pieces · ¥238,230/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Export to new Google workbook" }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: `${reportName} — S067690` }).click();
  await expect(page.getByText(/911 pieces · ¥238,230/)).toBeVisible();
  await page
    .getByRole("button", { name: "Select all 69 shown products" })
    .click();
  const penCount = fixture.order.rows
    .slice(10, 79)
    .filter((r) =>
      [r[2], r[4], r[1], r[10], r[9]]
        .join(" ")
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes("pen"),
    ).length;
  expect(penCount).toBeGreaterThan(0);
  expect(penCount).toBeLessThan(69);
  await page.getByLabel("Filter products").fill("  PeN  ");
  await expect(page.getByRole("checkbox")).toHaveCount(penCount);
  await expect(
    page.getByRole("group", {
      name: `Assign to ${penCount} selected products`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await page
    .getByRole("button", { name: `Select all ${penCount} shown products` })
    .click();
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(
    penCount,
  );
  await page
    .getByRole("heading", { name: "Review HS classifications" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("hs-review-filter.png") });
  await page.getByLabel("Filter products").fill("no-products-match-this");
  await expect(page.getByText("No products match this filter.")).toBeVisible();
  await expect(
    page.getByRole("group", {
      name: "Assign to 0 selected products",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("Filter products").fill("");
  await expect(page.getByRole("checkbox")).toHaveCount(69);
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Select all 69 shown products" })
    .click();
  await expect(
    page.getByLabel(/English override|Bulgarian override/),
  ).toHaveCount(0);
  await page.getByLabel("HS code", { exact: true }).fill("48201030");
  await page
    .getByRole("button", { name: "Apply code to selected products" })
    .click();
  await expect(page.getByText("No classifications need review.")).toBeVisible();
  await page
    .getByLabel("Measured shipment gross (kg)", { exact: true })
    .fill("33");
  await page
    .getByLabel("Measurement source")
    .fill("Synthetic browser test measurement");
  await page.getByLabel("Package convention").selectOption("cartons");
  await page
    .getByRole("button", { name: "Save measurements and convention" })
    .click();
  await expect(
    page.getByRole("button", { name: "Export to new Google workbook" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Export to new Google workbook" })
    .click();
  await expect(page.getByText(/Verified against preview/)).toBeVisible({
    timeout: 30000,
  });
  expect(creates).toBe(1);
  expect(exported["'Ognyan Summary'"][6]).toEqual([
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
  await page.reload();
  await page.getByRole("button", { name: `${reportName} — S067690` }).click();
  await expect(page.getByText(/Verified against preview/)).toBeVisible();
  const renamed = reportName + " renamed";
  await page.getByLabel("Saved report name", { exact: true }).fill(renamed);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: renamed, exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: renamed + " — S067690", exact: true })
    .click();
  await expect(page.getByText(/Verified against preview/)).toBeVisible();
  await page
    .getByRole("button", { name: "Abandon report", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: renamed + " — S067690", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: renamed + " — S067690", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show abandoned reports", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: renamed + " — S067690 (abandoned)",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Export to new Google workbook" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restore report", exact: true })
    .click();
  await expect(page.getByText(/Verified against preview/)).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: renamed + " — S067690", exact: true })
    .click();
  await expect(page.getByText(/Verified against preview/)).toBeVisible();
});
