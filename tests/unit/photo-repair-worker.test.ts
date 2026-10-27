import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const { fetchSourceBytes, emitRepairResult, processRequestEvent } =
  createRequire(import.meta.url)(
    "../../functions/shared/photos-sync-worker.cjs",
  );
const response = (bytes: string) =>
  new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/jpeg" },
  });
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("original photo download", () => {
  it("never requests the successful bare preview", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        return response(
          url.endsWith("=d") ? "original bytes" : "preview bytes",
        );
      }),
    );
    const result = await fetchSourceBytes({
      photoId: "photo",
      sourceBaseUrl: "https://lh3.googleusercontent.com/p/source=w512-h512",
    });
    expect(calls).toEqual(["https://lh3.googleusercontent.com/p/source=d"]);
    expect(result.bytes.toString()).toBe("original bytes");
  });
  it("fails when the original download fails instead of accepting a preview", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith("=d")
        ? new Response("expired", { status: 403 })
        : response("preview"),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchSourceBytes({
        photoId: "photo",
        sourceBaseUrl: "https://lh3.googleusercontent.com/p/source",
      }),
    ).rejects.toThrow("source_fetch_failed");
    expect(fetch.mock.calls.every(([url]) => url.endsWith("=d"))).toBe(true);
  });
  it("preserves durable Drive source URLs", async () => {
    const fetch = vi.fn(async () => response("drive original"));
    vi.stubGlobal("fetch", fetch);
    const url = "https://lh3.googleusercontent.com/d/1234567890abcdef=s0";
    await fetchSourceBytes({ photoId: "photo", sourceBaseUrl: url });
    expect(fetch.mock.calls[0]).toEqual([url]);
  });
  it("routes repair completions to repair events without active-photo actions", async () => {
    const created: any[] = [];
    const db = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          create: async (data: any) => created.push({ name, id, ...data }),
        }),
      }),
    };
    await emitRepairResult(
      db,
      "request-doc",
      "request",
      "worker",
      { kind: "step", entryId: "entry", attemptId: "attempt", stepIndex: 0 },
      { artifact: { url: "new" } },
    );
    expect(created).toHaveLength(1);
    expect(created[0].type).toBe("photoRepair/stepCompleted");
    expect(created[0].payload).toEqual({
      entryId: "entry",
      attemptId: "attempt",
      stepIndex: 0,
      requestId: "request",
      artifact: { url: "new" },
    });
  });
});

it("executes an original repair import with its real Google ID and records only a repair completion", async () => {
  const saved = new Map<string, any>();
  saved.set("sync_secrets/secret", {
    driveAccessToken: "fake-drive",
    photosAccessToken: "fake-photos",
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        get: async () => ({
          id,
          exists: saved.has(`${name}/${id}`),
          data: () => saved.get(`${name}/${id}`),
        }),
        create: async (data: any) => {
          const key = `${name}/${id}`;
          if (saved.has(key))
            throw Object.assign(Error("already exists"), { code: 6 });
          saved.set(key, data);
        },
      }),
      add: async (data: any) => saved.set(`${name}/log-${saved.size}`, data),
    }),
  };
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: any) => {
      fetched.push(url);
      const json = (data: any) =>
        new Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        });
      if (url.includes("mediaItems/"))
        return json({
          baseUrl: "https://lh3.googleusercontent.com/p/refreshed",
        });
      if (url.includes("googleusercontent.com"))
        return response("full original");
      if (url.includes("uploadType=multipart")) {
        expect(options.body.toString()).toContain("full original");
        expect(options.body.toString()).toContain(
          "repair_original:import:identity",
        );
        return json({ id: "new-drive", name: "original.png" });
      }
      if (url.includes("/permissions")) return json({});
      if (url.includes("files/new-drive"))
        return json({
          id: "new-drive",
          name: "original.png",
          mimeType: "image/jpeg",
          webViewLink: "drive-view",
        });
      return json({ files: [] });
    }),
  );
  const result = await processRequestEvent({
    db,
    collectionName: "sync",
    requestEventId: "operation",
    requestId: "request",
    processor: "test",
    creator: "worker",
    requestData: {
      eventType: "photos/image_transfer_requested",
      requestId: "request",
      creator: "user",
      photoId: "repair-source:source:import",
      payload: {
        photoId: "repair-source:source:import",
        sourceBaseUrl: "https://lh3.googleusercontent.com/p/old",
        sourceType: "photos",
        sourceRef: { mediaItemId: "real-google-id" },
        secretRef: { docId: "secret" },
        repair: { kind: "original", sourceId: "source", importId: "import" },
        filename: "original.png",
        mimeType: "image/png",
      },
    },
  });
  expect(result.processed).toBe(true);
  expect(fetched.some((url) => url.includes("mediaItems/real-google-id"))).toBe(
    true,
  );
  expect(
    fetched.filter((url) => url.includes("googleusercontent.com")),
  ).toEqual(["https://lh3.googleusercontent.com/p/refreshed=d"]);
  const facts = [...saved.entries()]
    .filter(([key]) => key.startsWith("broadcast/"))
    .map(([, value]) => value);
  expect(facts.map((v) => v.type)).toEqual(["photoRepair/originalImported"]);
  expect(facts[0].payload.artifact.driveFileId).toBe("new-drive");
  expect(facts[0].payload.artifact.mimeType).toBe("image/jpeg");
});
