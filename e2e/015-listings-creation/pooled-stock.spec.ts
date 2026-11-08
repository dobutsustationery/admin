import { test, expect } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";

test("pooled scissors quantities can be edited and approved as 8/8/8", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(120000);
  const jan = "4571207041654";
  await page.route("https://mock.photos/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="grey"/></svg>',
    }),
  );
  await page.goto("/");
  await waitForAppReady(page);
  await page.waitForFunction(
    () => (window as any).testHelpers?.store.getState().inventory.initialized,
  );
  await page.evaluate((jan) => {
    const { store, actions } = (window as any).testHelpers;
    store.dispatch(
      actions.create_listing({
        listing: {
          handle: "pooled-category-fixture",
          title: "Category fixture",
          productCategory: "Stationery",
          images: [],
        },
      }),
    );
    store.dispatch({
      ...actions.bulk_import_items({
        items: ["Blue", "Grey"].map((subtype) => ({
          id: jan + subtype,
          type: "new",
          stockOrder: { orderId: "pooled-browser-receipt", orderedQty: 12 },
          item: {
            janCode: jan,
            subtype,
            description: "Pocket scissors",
            qty: 12,
            shipped: 0,
            pieces: 1,
            price: 4.95,
            handle: "",
            image: "https://mock.photos/Grey.svg",
          },
        })),
      }),
      id: "pooled-browser-receipt",
      timestamp: {
        _seconds: Date.parse("2026-11-01T00:00:00Z") / 1000,
        _nanoseconds: 0,
      },
    });
    store.dispatch(
      actions.add_proposals([
        {
          janCode: jan,
          allocationMode: "pooled-stock-v1",
          title: "Pocket scissors",
          handle: "pooled-scissors-browser",
          bodyHtml: "<p>Scissors</p>",
          price: 4.95,
          productCategory: "Stationery",
          vendor: "Senshu",
          tags: [],
          option1Name: "Colour",
          status: "draft",
          photoGroupIds: [],
          variants: ["Blue", "Grey", "Pink"].map((name) => ({
            id: `${jan}:${name}:browser`,
            option1Value: name,
            image: `https://mock.photos/${name}.svg`,
          })),
        },
      ]),
    );
    store.dispatch(
      actions.start_batch({ janCodes: [jan], batchId: "pooled-browser" }),
    );
  }, jan);

  await page.evaluate((jan) => {
    const link = document.createElement("a");
    link.href = `/listing-detail?mode=create&janCode=${jan}`;
    link.textContent = "Review pooled scissors";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, jan);
  await expect(page).toHaveURL(/listing-detail/);

  const qty = (name: string) =>
    page
      .locator(".subtype-row")
      .filter({
        has: page.locator(".subtype-label", {
          hasText: new RegExp(`^${name}$`),
        }),
      })
      .locator('input[type="number"]');
  const approve = page.getByRole("button", {
    name: "Approve & Publish",
    exact: true,
  });
  for (const name of ["Blue", "Grey", "Pink"])
    await expect(qty(name)).toHaveValue("8");
  await expect(page.locator(".pooled-stock-summary")).toContainText(
    "24 / 24 units allocated",
  );
  await expect(approve).toBeEnabled();

  // Editing a row must not apply the old 12-minus-this-row rule to its sibling.
  await qty("Blue").fill("7");
  await expect(qty("Pink")).toHaveValue("8");
  await expect(qty("Grey")).toHaveValue("8");
  await expect(page.locator(".pooled-stock-summary")).toContainText(
    "23 / 24 units allocated",
  );
  await expect(approve).toBeDisabled();
  await qty("Blue").fill("8");
  await expect(qty("Pink")).toHaveValue("8");
  await expect(approve).toBeEnabled();

  await qty("Pink").fill("9");
  await expect(qty("Blue")).toHaveValue("8");
  await expect(approve).toBeDisabled();
  await qty("Pink").fill("8");
  await expect(qty("Blue")).toHaveValue("8");
  await expect(approve).toBeEnabled();
  // Reproduce the reported Manage Variants path, starting with saved 4/4/4.
  for (const name of ["Blue", "Grey", "Pink"]) await qty(name).fill("4");
  await page.getByRole("button", { name: "Manage Variants" }).click();
  const dialog = page
    .locator(".modal")
    .filter({ has: page.locator(".allocation-section") });
  const dialogRow = (name: string) =>
    dialog.locator(".allocation-row").filter({
      has: page.locator(".alloc-subtype", { hasText: new RegExp(`^${name}$`) }),
    });
  const confirm = dialog.getByRole("button", { name: "Confirm Changes" });
  for (const name of ["Blue", "Grey", "Pink"]) {
    await expect(dialogRow(name).locator('input[type="number"]')).toHaveValue(
      "4",
    );
    await expect(
      dialogRow(name).getByRole("img", { name, exact: true }),
    ).toHaveAttribute("src", `https://mock.photos/${name}.svg`);
  }
  await expect(dialog.locator(".allocation-summary")).toContainText("12 / 24");
  await expect(confirm).toBeDisabled();
  for (const name of ["Blue", "Grey", "Pink"])
    await dialogRow(name).locator('input[type="number"]').fill("8");
  await expect(dialog.locator(".allocation-summary")).toContainText("24 / 24");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  for (const name of ["Blue", "Grey", "Pink"])
    await expect(qty(name)).toHaveValue("8");
  await expect(approve).toBeEnabled();
  // Reopening reads the saved choices rather than keeping old dialog state.
  await page.getByRole("button", { name: "Manage Variants" }).click();
  for (const name of ["Blue", "Grey", "Pink"])
    await expect(dialogRow(name).locator('input[type="number"]')).toHaveValue(
      "8",
    );
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await approve.click();
  await expect
    .poll(() =>
      page.evaluate((jan) => {
        const s = (window as any).testHelpers.store.getState();
        return ["Blue", "Grey", "Pink"].map((name) => {
          const item = s.inventory.idToItem[jan + name];
          return {
            stock: item ? item.qty - item.shipped : null,
            handle: item?.handle,
          };
        });
      }, jan),
    )
    .toEqual(
      ["Blue", "Grey", "Pink"].map(() => ({
        stock: 8,
        handle: "pooled-scissors-browser",
      })),
    );
});
