import { describe, it, expect } from "vitest";
import { assertNoBinaryPayload } from "../../src/lib/redux-firestore";

describe("assertNoBinaryPayload", () => {
  describe("accepts safe values", () => {
    it("accepts undefined payload", () => {
      expect(() => assertNoBinaryPayload(undefined)).not.toThrow();
    });

    it("accepts null", () => {
      expect(() => assertNoBinaryPayload(null)).not.toThrow();
    });

    it("accepts a plain string URL", () => {
      expect(() =>
        assertNoBinaryPayload("https://lh3.googleusercontent.com/d/FILE=s200"),
      ).not.toThrow();
    });

    it("accepts numbers and booleans", () => {
      expect(() => assertNoBinaryPayload(42)).not.toThrow();
      expect(() => assertNoBinaryPayload(true)).not.toThrow();
    });

    it("accepts a flat object with safe string values", () => {
      expect(() =>
        assertNoBinaryPayload({
          id: "abc123",
          url: "https://drive.google.com/file/d/ID/view",
          count: 5,
        }),
      ).not.toThrow();
    });

    it("accepts a nested object with safe values", () => {
      expect(() =>
        assertNoBinaryPayload({
          photos: [
            { id: "1", baseUrl: "https://lh3.googleusercontent.com/photo/ID" },
            { id: "2", baseUrl: "https://lh3.googleusercontent.com/photo/ID2" },
          ],
        }),
      ).not.toThrow();
    });

    it("accepts an empty array", () => {
      expect(() => assertNoBinaryPayload([])).not.toThrow();
    });
  });

  describe("rejects data: URIs", () => {
    it("rejects a bare data: string", () => {
      expect(() => assertNoBinaryPayload("data:image/png;base64,abc")).toThrow(
        /data: URI/,
      );
    });

    it("rejects a data: URI nested in an object", () => {
      expect(() =>
        assertNoBinaryPayload({ image: "data:image/jpeg;base64,/9j/abc" }),
      ).toThrow(/data: URI/);
    });

    it("rejects a data: URI nested inside an array", () => {
      expect(() =>
        assertNoBinaryPayload({
          urls: ["https://ok.com", "data:text/plain,x"],
        }),
      ).toThrow(/data: URI/);
    });

    it("includes the path in the error message", () => {
      expect(() =>
        assertNoBinaryPayload({ nested: { img: "data:image/gif;base64,R0" } }),
      ).toThrow(/payload\.nested\.img/);
    });
  });

  describe("rejects blob: URLs", () => {
    it("rejects a bare blob: string", () => {
      expect(() =>
        assertNoBinaryPayload("blob:https://localhost/uuid-1234"),
      ).toThrow(/blob: URL/);
    });

    it("rejects a blob: URL nested in an object", () => {
      expect(() =>
        assertNoBinaryPayload({ preview: "blob:https://localhost/uuid-1234" }),
      ).toThrow(/blob: URL/);
    });

    it("includes the path in the error message for array elements", () => {
      expect(() =>
        assertNoBinaryPayload(["blob:https://localhost/uuid-1234"]),
      ).toThrow(/payload\[0\]/);
    });
  });

  describe("rejects binary object types", () => {
    it("rejects a Blob instance", () => {
      expect(() => assertNoBinaryPayload(new Blob(["hello"]))).toThrow(
        /Blob\/File/,
      );
    });

    it("rejects a Blob nested in an object", () => {
      expect(() => assertNoBinaryPayload({ file: new Blob(["data"]) })).toThrow(
        /Blob\/File/,
      );
    });

    it("rejects an ArrayBuffer", () => {
      expect(() => assertNoBinaryPayload(new ArrayBuffer(8))).toThrow(
        /ArrayBuffer/,
      );
    });

    it("rejects an ArrayBuffer nested in an object", () => {
      expect(() =>
        assertNoBinaryPayload({ bytes: new ArrayBuffer(8) }),
      ).toThrow(/ArrayBuffer/);
    });
  });
});
