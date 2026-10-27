import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { initializeFirestore, Timestamp } from "firebase-admin/firestore";

test("repair candidates survive reload, redo and require approval before replacement", async ({
  page,
  context,
  authenticatedPage,
}) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const key = `repair-${Date.now()}`;
  const app = initializeApp({ projectId: "demo-test-project" }, key);
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
  });
  const jan = "4999999999911",
    photoId = `${key}-photo`,
    sourceId = `${key}-source`,
    entryId = `${key}-entry`;
  const oldUrl = "https://example.com/old-photo.png",
    newUrl = "https://example.com/original-photo.png";
  const artifact = {
    driveFileId: "test-original-file",
    url: newUrl,
    webViewLink: newUrl,
    filename: "original.png",
    mimeType: "image/png",
  };
  const seeded: any[] = [];
  async function event(type: string, payload: any) {
    const ref = db.collection("broadcast").doc();
    await ref.set({
      type,
      payload,
      creator: "photo-repair-test",
      timestamp: Timestamp.now(),
    });
    seeded.push(ref);
    return ref;
  }
  const targets = [
    { ref: { kind: "photo_registry", photoId }, beforeUrl: oldUrl },
    { ref: { kind: "photo_group", groupKey: jan, photoId }, beforeUrl: oldUrl },
    { ref: { kind: "inventory", itemKey: jan }, beforeUrl: oldUrl },
  ];
  await event("update_item", {
    id: jan,
    item: {
      janCode: jan,
      subtype: "",
      description: key,
      image: oldUrl,
      qty: 2,
      pieces: 1,
    },
  });
  const photo = {
    id: photoId,
    filename: "test-original.png",
    mimeType: "image/png",
    baseUrl: oldUrl,
    productUrl: oldUrl,
  };
  await event("photos/register_media_items", { items: [photo] });
  await event("photos/categorize_photo", { janCode: jan, photo });
  await event("photoRepair/sourceAdded", {
    sourceId,
    originalGoogleMediaId: "test-google-id",
  });
  await event("photoRepair/entryAdded", {
    entryId,
    sourceId,
    existingPhotoId: photoId,
    oldImageUrl: oldUrl,
    targets,
    evidence: { kind: "bad_import", transferEventIds: [] },
  });
  await event("photoRepair/originalRequested", {
    sourceId,
    importId: key,
    requestId: key,
    choice: { kind: "upload", filename: "original.png", mimeType: "image/png" },
  });
  await event("photoRepair/originalImported", {
    sourceId,
    importId: key,
    requestId: key,
    artifact,
  });
  await context.route("https://example.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="green"/></svg>',
    }),
  );
  await context.addInitScript(() => {
    (window as any).__GOOGLE_DRIVE_FOLDER_ID__ = "test-root";
    localStorage.setItem(
      "google_photos_access_token",
      JSON.stringify({
        access_token: "fake-photo-repair-token",
        expires_in: 3600,
        expires_at: Date.now() + 3600000,
        scope:
          "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
        token_type: "Bearer",
      }),
    );
  });
  await context.route("https://www.googleapis.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("uploadType=resumable"))
      return route.fulfill({
        status: 200,
        headers: {
          Location: "https://www.googleapis.com/repair-test-upload",
          "access-control-expose-headers": "location",
        },
        body: "{}",
      });
    if (url.includes("repair-test-upload"))
      return route.fulfill({
        status: 200,
        json: { id: "test-uploaded-original" },
      });
    if (url.includes("alt=media"))
      return route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo4AAAAASUVORK5CYII=",
          "base64",
        ),
      });
    if (url.includes("/files?"))
      return route.fulfill({
        status: 200,
        json: { files: [{ id: "test-folder", name: "Originals" }] },
      });
    if (url.includes("/permissions"))
      return route.fulfill({ status: 200, json: {} });
    return route.fulfill({
      status: 200,
      json: {
        id: "test-uploaded-original",
        name: "original.png",
        webViewLink: "https://example.com/uploaded-original.png",
      },
    });
  });
  try {
    await page.goto("/photo-repair");
    await page.getByRole("searchbox").fill(key);
    const row = page.locator("tbody tr").filter({ hasText: key });
    await row.getByRole("button", { name: "Review", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Approve and update", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("Upload original").setInputFiles({
      name: "fresh-original.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo4AAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect
      .poll(async () => {
        const docs = await db
          .collection("broadcast")
          .where("type", "==", "photoRepair/originalImported")
          .get();
        return docs.docs.some(
          (d) =>
            d.data().payload.sourceId === sourceId &&
            d.data().payload.artifact.driveFileId === "test-uploaded-original",
        );
      })
      .toBe(true);
    await page.getByLabel("Colour correction", { exact: true }).uncheck();
    await page.getByLabel("Remove background", { exact: true }).uncheck();
    await page
      .getByRole("button", { name: "Process original", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve and update", exact: true }),
    ).toBeEnabled();
    const first = await db
      .collection("broadcast")
      .where("type", "==", "photoRepair/attemptStarted")
      .get();
    const attempts = first.docs.filter(
      (d) => d.data().payload.entryId === entryId,
    );
    expect(attempts).toHaveLength(1);
    await page
      .getByRole("button", { name: "Redo processing", exact: true })
      .click();
    await expect
      .poll(async () => {
        const s = await db
          .collection("broadcast")
          .where("type", "==", "photoRepair/attemptStarted")
          .get();
        return s.docs.filter((d) => d.data().payload.entryId === entryId)
          .length;
      })
      .toBe(2);
    const approvalsBefore = await db
      .collection("broadcast")
      .where("type", "==", "photoRepair/approved")
      .get();
    expect(
      approvalsBefore.docs.filter((d) => d.data().payload.entryId === entryId),
    ).toHaveLength(0);
    await page.reload();
    await page.getByRole("searchbox").fill(key);
    await page
      .locator("tbody tr")
      .filter({ hasText: key })
      .getByRole("button", { name: "Review", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve and update", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: "/tmp/photo-repair-candidate.png",
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Approve and update", exact: true })
      .click();
    await expect(
      page.getByText("Approved and updated.", { exact: true }),
    ).toBeVisible();
    const approvals = await db
      .collection("broadcast")
      .where("type", "==", "photoRepair/approved")
      .get();
    expect(
      approvals.docs.filter((d) => d.data().payload.entryId === entryId),
    ).toHaveLength(1);
    await page.reload();
    await page.getByRole("searchbox").fill(key);
    await expect(
      page.locator("tbody tr").filter({ hasText: key }),
    ).toContainText("Done");
  } finally {
    const repairDocs = await db.collection("broadcast").get();
    for (const d of repairDocs.docs) {
      const p = d.data().payload || {};
      if (
        p.entryId === entryId ||
        (p.attemptId && String(p.attemptId).startsWith(key))
      )
        seeded.push(d.ref);
    }
    for (const ref of seeded) await ref.delete();
    await deleteApp(app);
  }
});
