// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import SecureImage from "../../src/lib/components/SecureImage.svelte";

// Mock dependencies
vi.mock("$lib/google-photos", () => ({
  getStoredToken: vi.fn(() => ({ access_token: "fake-token" })),
}));

vi.mock("$lib/google-drive", () => ({
  getStoredToken: vi.fn(() => ({ access_token: "fake-drive-token" })),
}));

vi.mock("$lib/image-queue", () => ({
  imageQueue: {
    add: vi.fn(async (fn) => fn()),
  },
}));

describe("SecureImage - Progressive Loading", () => {
  let container: HTMLElement;
  let resolveDecode: () => void;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        return {
          ok: true,
          blob: async () =>
            new Blob(["fake-image-data"], { type: "image/jpeg" }),
          status: 200,
        };
      }),
    );

    // Mock URL.createObjectURL and revokeObjectURL
    vi.stubGlobal("URL", {
      ...globalThis.URL,
      createObjectURL: vi.fn((blob) => `blob:http://localhost/fake-uuid`),
      revokeObjectURL: vi.fn(),
    });

    // Mock Image decode to be controllable
    const decodePromise = new Promise<void>((r) => {
      resolveDecode = r;
    });
    const decodeMock = vi.fn().mockReturnValue(decodePromise);

    vi.stubGlobal(
      "Image",
      class {
        src = "";
        decode = decodeMock;
      },
    );
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  it("should mount and request preview then full size", async () => {
    const component = new SecureImage({
      target: container,
      props: {
        src: "https://lh3.googleusercontent.com/d/1234567890",
        size: "full",
      },
    });

    // Wait for async operations (the preview URL set)
    await new Promise((r) => setTimeout(r, 50));

    const img = container.querySelector("img");
    expect(img).not.toBeNull();

    // Because it's a drive public URL, fetchImageData returns the URL directly
    // Preview URL should be set first
    expect(img!.src).toContain("=s800");
    expect(img!.src).not.toContain("=s0");

    // Resolve the decode promise
    resolveDecode!();

    // Wait for the full URL to be set
    await new Promise((r) => setTimeout(r, 50));

    // Full URL should be set after decode
    expect(img!.src).toContain("=s0");
    expect(img!.src).not.toContain("=s800");

    component.$destroy();
  });
});
