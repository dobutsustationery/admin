import { describe, it, expect } from "vitest";
import { generateDerivationKey } from "../../src/lib/idempotency-utils";

describe("idempotency-utils", () => {
  describe("generateDerivationKey", () => {
    it("should generate a simple key for short IDs", () => {
      const key = generateDerivationKey("photos", "short-id", "identity");
      expect(key).toBe("photos:short-id:identity_original_v2");
    });

    it("keeps ordinary Drive identities and separates fresh repair attempts", () => {
      expect(generateDerivationKey("drive", "file", "identity")).toBe(
        "drive:file:identity",
      );
      expect(
        generateDerivationKey("repair_step", "attempt-a-0", "crop"),
      ).not.toBe(generateDerivationKey("repair_step", "attempt-b-0", "crop"));
    });

    it("should handle remove_bg versioning", () => {
      const key = generateDerivationKey("photos", "short-id", "remove_bg");
      expect(key).toBe("photos:short-id:remove_bg_v2");
    });

    it("should shorten extremely long IDs to fit Google Drive limits", () => {
      // 120 character ID
      const longId = "A".repeat(120);
      const key = generateDerivationKey("photos", longId, "identity");

      expect(key).not.toBeNull();
      expect(key!.length).toBeLessThanOrEqual(110);
      expect(key).toMatch(/^photos:h_A{32}_\w{8}:identity_original_v2$/);
    });

    it("should be deterministic for long IDs", () => {
      const longId = "A".repeat(120);
      const key1 = generateDerivationKey("photos", longId, "identity");
      const key2 = generateDerivationKey("photos", longId, "identity");
      expect(key1).toBe(key2);
    });

    it("should be unique for different long IDs", () => {
      const longId1 = "A".repeat(120);
      const longId2 = "A".repeat(119) + "B";
      const key1 = generateDerivationKey("photos", longId1, "identity");
      const key2 = generateDerivationKey("photos", longId2, "identity");
      expect(key1).not.toBe(key2);
    });
  });
});
