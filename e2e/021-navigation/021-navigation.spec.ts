import { test, expect } from "../fixtures/auth";

test("operational navigation, tools and obsolete routes remain reachable", async ({
  page,
  authenticatedPage,
}) => {
  void authenticatedPage;
  test.setTimeout(60000);
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav).toBeVisible();
  await expect(nav.locator(".nav-links > li")).toHaveCount(16);
  const tools = nav
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Tools" }) });
  const obsolete = nav
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Obsolete" }) });
  await expect(tools).not.toHaveAttribute("open", "");
  await expect(obsolete).not.toHaveAttribute("open", "");
  await expect(
    nav.getByRole("link", { name: "Amazon Listings", exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".quick-actions").getByRole("link", { name: "Receive Order" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".quick-actions")
      .getByRole("link", { name: "Customs Summary" }),
  ).toBeVisible();
  await tools.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(tools.getByRole("link")).toHaveCount(11);
  await tools.getByRole("link", { name: "Item History", exact: true }).click();
  await expect(page).toHaveURL(/\/itemhistory\/?$/);
  await expect(tools).toHaveAttribute("open", "");
  await expect(
    tools.getByRole("link", { name: "Item History", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.goto("/archives?navigation-test=1");
  await expect(obsolete).toHaveAttribute("open", "");
  await expect(obsolete.getByRole("link")).toHaveCount(8);
  await expect(
    obsolete.getByRole("link", { name: "Archives", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await nav.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(obsolete).not.toHaveAttribute("open", "");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Open navigation", exact: true })
    .click();
  await expect(nav).toHaveClass(/open/);
  await tools.locator("summary").click();
  await expect(nav).toHaveClass(/open/);
  await tools.getByRole("link", { name: "Export CSV", exact: true }).click();
  await expect(page).toHaveURL(/\/csv\/?$/);
  await expect(nav).not.toHaveClass(/open/);
  await expect(
    page.getByRole("button", { name: "Open navigation", exact: true }),
  ).toBeVisible();
});
