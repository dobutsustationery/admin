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
  await event("create_listing", {
    listing: {
      handle: key,
      title: key,
      images: [{ id: photoId, url: oldUrl, position: 1, altText: "" }],
      status: "no_sync",
    },
  });
  await event("update_field", { id: jan, field: "handle", from: "", to: key });
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
    // Production's original discovery events had no measurements or imports.
    // They must remain visible after replay, in both the queue and saved work.
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Not checked");
    await page.reload();
    await page.getByRole("searchbox").fill(key);
    await expect(row).toHaveCount(1);
    await page.getByRole("button", { name: "Saved work", exact: true }).click();
    await expect(row).toHaveCount(1);
    await page
      .getByRole("button", { name: "Needs photos", exact: true })
      .click();
    await event("photoRepair/originalRequested", {
      sourceId,
      importId: key,
      requestId: key,
      choice: {
        kind: "upload",
        filename: "original.png",
        mimeType: "image/png",
      },
    });
    await event("photoRepair/originalImported", {
      sourceId,
      importId: key,
      requestId: key,
      artifact,
    });
    await expect(row).toContainText("Ready to process");
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
    await page.getByRole("button", { name: "Saved work", exact: true }).click();
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

test("checks current stocked photos, skips fixed images, remembers good decisions and fills missing photos", async ({
  page,
  context,
  authenticatedPage,
}) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const key = `stock-photos-${Date.now()}`;
  const app = initializeApp({ projectId: "demo-test-project" }, key);
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
  });
  const tracked: any[] = [];
  const at = () => Timestamp.now();
  async function event(type: string, payload: any) {
    const ref = db.collection("broadcast").doc();
    await ref.set({
      type,
      payload,
      creator: "stock-photo-test",
      timestamp: at(),
    });
    tracked.push(ref);
  }
  const ids = {
    bad: `${key}-bad`,
    good: `${key}-good`,
    missing: `${key}-missing`,
    sold: `${key}-sold`,
  };
  const urls = {
    bad: `https://example.com/${key}/bad.svg`,
    good: `https://example.com/${key}/good.svg`,
    sold: `https://example.com/${key}/sold.svg`,
  };
  for (const [kind, itemId] of Object.entries(ids))
    await event("update_item", {
      id: itemId,
      item: {
        janCode: itemId,
        subtype: "",
        description: `${key} ${kind}`,
        qty: kind === "sold" ? 0 : 2,
        pieces: 1,
        image: kind === "missing" ? "" : urls[kind as keyof typeof urls],
      },
    });
  await event("create_listing", {
    listing: {
      handle: key,
      title: `${key} missing`,
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "",
      tags: [],
      status: "no_sync",
      option1Name: "Subtype",
      images: [],
      lastUpdated: 0,
    },
  });
  await event("update_field", {
    id: ids.missing,
    field: "handle",
    from: "",
    to: key,
  });
  for (const kind of ["bad", "good", "sold"] as const) {
    const handle = `${key}-${kind}-listing`;
    await event("create_listing", {
      listing: {
        handle,
        title: `${key} ${kind}`,
        images: [],
        status: "no_sync",
      },
    });
    await event("update_field", {
      id: ids[kind],
      field: "handle",
      from: "",
      to: handle,
    });
  }
  // A known historical bad import must not make a currently large photo a repair task.
  await event("photoRepair/sourceAdded", {
    sourceId: key,
    originalGoogleMediaId: `${key}-old-google`,
  });
  await event("photoRepair/entryAdded", {
    entryId: `${key}-old-entry`,
    sourceId: key,
    oldImageUrl: urls.good,
    targets: [
      { ref: { kind: "inventory", itemKey: ids.good }, beforeUrl: urls.good },
    ],
    evidence: { kind: "bad_import", transferEventIds: [] },
  });
  await context.route(`https://example.com/${key}/**`, (route) => {
    const size = route.request().url().includes("good") ? 1600 : 400;
    return route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="100%" height="100%" fill="green"/></svg>`,
    });
  });
  try {
    await page.goto("/photo-repair");
    await page
      .getByRole("button", { name: "Check stocked item photos", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Checked 3 current photos. 2 need attention." }),
    ).toBeVisible();
    const rows = page.locator("tbody tr");
    await expect(rows.filter({ hasText: `${key} bad` })).toHaveCount(1);
    await expect(rows.filter({ hasText: `${key} missing` })).toHaveCount(1);
    await expect(rows.filter({ hasText: `${key} good` })).toHaveCount(0);
    await expect(rows.filter({ hasText: `${key} sold` })).toHaveCount(0);
    await rows
      .filter({ hasText: `${key} bad` })
      .getByRole("button", { name: "Review", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Photo is good — no repair needed",
        exact: true,
      })
      .click();
    await expect(rows.filter({ hasText: `${key} bad` })).toHaveCount(0);
    await page.reload();
    await expect(
      page.locator("tbody tr").filter({ hasText: `${key} bad` }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Other stocked photos", exact: true })
      .click();
    await page
      .locator("tbody tr")
      .filter({ hasText: `${key} good` })
      .getByRole("button", { name: "Needs a better photo", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Photo repair review" }),
    ).toContainText(`${key} good`);
    await page
      .getByRole("button", { name: "Needs photos", exact: true })
      .click();
    await page
      .locator("tbody tr")
      .filter({ hasText: `${key} missing` })
      .getByRole("button", { name: "Review", exact: true })
      .click();
    const entries = await db
      .collection("broadcast")
      .where("type", "==", "photoRepair/entryAdded")
      .get();
    const missing = entries.docs
      .find((d) =>
        d
          .data()
          .payload.targets.some(
            (t: any) =>
              t.ref.kind === "inventory" && t.ref.itemKey === ids.missing,
          ),
      )!
      .data().payload;
    const importId = `${key}-upload`;
    await event("photoRepair/originalRequested", {
      sourceId: missing.sourceId,
      importId,
      requestId: importId,
      choice: {
        kind: "upload",
        filename: "correct-original.png",
        mimeType: "image/png",
      },
    });
    await event("photoRepair/originalImported", {
      sourceId: missing.sourceId,
      importId,
      requestId: importId,
      artifact: {
        driveFileId: "correct-file",
        url: urls.good,
        webViewLink: urls.good,
        filename: "correct-original.png",
        mimeType: "image/png",
      },
    });
    await page
      .getByRole("button", { name: "Use original as candidate", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Approve and update", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Approve and update", exact: true })
      .click();
    await expect(
      page.getByText("Approved and updated.", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: "/tmp/photo-repair-stock-corrected.png",
      fullPage: true,
    });
  } finally {
    const events = await db.collection("broadcast").get();
    for (const d of events.docs) {
      const p = d.data().payload || {};
      if (JSON.stringify(p).includes(key)) tracked.push(d.ref);
    }
    for (const ref of tracked) await ref.delete();
    await deleteApp(app);
  }
});

test("groups detected photos by listing with hover previews and excludes standalone photos", async ({
  page,
  context,
  authenticatedPage,
}) => {
  void authenticatedPage;
  test.setTimeout(30000);
  const key = `listing-photos-${Date.now()}`;
  const app = initializeApp({ projectId: "demo-test-project" }, key);
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
  });
  const seeded: any[] = [];
  async function event(type: string, payload: any) {
    const ref = db.collection("broadcast").doc();
    await ref.set({ type, payload, creator: key, timestamp: Timestamp.now() });
    seeded.push(ref);
  }
  const urls = ["first", "second", "standalone"].map(
    (name) => `https://example.com/${key}/${name}.svg`,
  );
  await context.route(`https://example.com/${key}/**`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="green"/></svg>',
    }),
  );
  try {
    await event("create_listing", {
      listing: {
        handle: key,
        title: key,
        status: "no_sync",
        images: urls.slice(0, 2).map((url, i) => ({
          id: `image-${i}`,
          url,
          position: i + 1,
          altText: "",
        })),
      },
    });
    await event("update_item", {
      id: key,
      item: {
        janCode: key,
        description: key,
        qty: 3,
        image: urls[0],
        handle: key,
        pieces: 1,
        subtype: "",
      },
    });
    await event("update_item", {
      id: `${key}-standalone`,
      item: {
        janCode: `${key}-standalone`,
        description: `${key} standalone`,
        qty: 5,
        image: urls[2],
        pieces: 1,
        subtype: "",
      },
    });
    await event("photoRepair/sourceAdded", {
      sourceId: key,
      originalGoogleMediaId: key,
    });
    for (const [i, url] of urls.entries()) {
      const ref =
        i < 2
          ? { kind: "listing_image", handle: key, imageId: `image-${i}` }
          : { kind: "inventory", itemKey: `${key}-standalone` };
      await event("photoRepair/entryAdded", {
        entryId: `${key}-${i}`,
        sourceId: key,
        oldImageUrl: url,
        targets: [{ ref, beforeUrl: url }],
        evidence: { kind: "bad_import", transferEventIds: [] },
      });
    }
    await page.goto("/photo-repair");
    await page.getByRole("searchbox").fill(key);
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(
      rows.getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(2);
    await expect(rows.locator("img")).toHaveCount(2);
    await rows.locator("img").first().hover();
    await expect(page.locator(".image-preview-overlay")).toBeVisible();
    await page.screenshot({
      path: "/tmp/photo-repair-listing-hover.png",
      fullPage: true,
    });
    await page.getByRole("heading", { level: 1 }).hover();
    await page.getByRole("button", { name: "Saved work", exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(
      rows.getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(2);
    await page
      .getByRole("button", { name: "Other stocked photos", exact: true })
      .click();
    await expect(rows).toHaveCount(1);
    await expect(rows.locator("img")).toHaveCount(2);
    await page.reload();
    await page.getByRole("searchbox").fill(key);
    await expect(rows).toHaveCount(1);
    await expect(
      rows.getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(2);
  } finally {
    for (const ref of seeded.reverse()) await ref.delete();
    await deleteApp(app);
  }
});
