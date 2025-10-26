import { describe, expect, it } from "vitest";
import {
  convertToEnv,
  extractConfig,
  validateConfig,
} from "../scripts/firebase-config-to-env.js";

describe("Firebase Config to .env Converter", () => {
  const sampleConfig = {
    apiKey: "AIzaSyTest123456789",
    authDomain: "test-project.firebaseapp.com",
    projectId: "test-project",
    storageBucket: "test-project.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef123456",
    measurementId: "G-ABCDEF1234",
  };

  describe("extractConfig", () => {
    it("should parse valid JSON", () => {
      const json = JSON.stringify(sampleConfig);
      const result = extractConfig(json);
      expect(result).toEqual(sampleConfig);
    });

    it("should parse JavaScript object literal", () => {
      const jsObject = `{
        apiKey: "AIzaSyTest123456789",
        authDomain: "test-project.firebaseapp.com",
        projectId: "test-project",
        storageBucket: "test-project.appspot.com",
        messagingSenderId: "123456789",
        appId: "1:123456789:web:abcdef123456",
        measurementId: "G-ABCDEF1234"
      }`;
      const result = extractConfig(jsObject);
      expect(result.apiKey).toBe("AIzaSyTest123456789");
      expect(result.projectId).toBe("test-project");
    });

    it("should handle const variable declaration", () => {
      const jsCode = `const firebaseConfig = ${JSON.stringify(sampleConfig)};`;
      const result = extractConfig(jsCode);
      expect(result).toEqual(sampleConfig);
    });

    it("should handle var variable declaration", () => {
      const jsCode = `var config = ${JSON.stringify(sampleConfig)};`;
      const result = extractConfig(jsCode);
      expect(result).toEqual(sampleConfig);
    });

    it("should handle let variable declaration", () => {
      const jsCode = `let myConfig = ${JSON.stringify(sampleConfig)};`;
      const result = extractConfig(jsCode);
      expect(result).toEqual(sampleConfig);
    });

    it("should handle single-line comments", () => {
      const jsCode = `// This is my Firebase config
      ${JSON.stringify(sampleConfig)}`;
      const result = extractConfig(jsCode);
      expect(result).toEqual(sampleConfig);
    });

    it("should handle multi-line comments", () => {
      const jsCode = `/* 
        Firebase Configuration
        For production use
      */
      ${JSON.stringify(sampleConfig)}`;
      const result = extractConfig(jsCode);
      expect(result).toEqual(sampleConfig);
    });

    it("should throw error for invalid input", () => {
      expect(() => extractConfig("not valid json or js")).toThrow();
    });
  });

  describe("validateConfig", () => {
    it("should validate a complete config", () => {
      expect(validateConfig(sampleConfig)).toBe(true);
    });

    it("should throw error if apiKey is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.apiKey;
      expect(() => validateConfig(invalid)).toThrow(/apiKey/);
    });

    it("should throw error if authDomain is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.authDomain;
      expect(() => validateConfig(invalid)).toThrow(/authDomain/);
    });

    it("should throw error if projectId is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.projectId;
      expect(() => validateConfig(invalid)).toThrow(/projectId/);
    });

    it("should throw error if storageBucket is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.storageBucket;
      expect(() => validateConfig(invalid)).toThrow(/storageBucket/);
    });

    it("should throw error if messagingSenderId is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.messagingSenderId;
      expect(() => validateConfig(invalid)).toThrow(/messagingSenderId/);
    });

    it("should throw error if appId is missing", () => {
      const invalid = { ...sampleConfig };
      delete invalid.appId;
      expect(() => validateConfig(invalid)).toThrow(/appId/);
    });

    it("should allow missing measurementId (optional)", () => {
      const configWithoutMeasurement = { ...sampleConfig };
      delete configWithoutMeasurement.measurementId;
      expect(validateConfig(configWithoutMeasurement)).toBe(true);
    });

    it("should throw error with multiple missing fields", () => {
      const invalid = {
        apiKey: "test",
        projectId: "test",
      };
      expect(() => validateConfig(invalid)).toThrow(/Missing required fields/);
    });
  });

  describe("convertToEnv", () => {
    it("should convert to production .env format", () => {
      const result = convertToEnv(sampleConfig, "production");

      expect(result).toContain("# Production Environment");
      expect(result).toContain("VITE_FIREBASE_ENV=production");
      expect(result).toContain("VITE_FIREBASE_API_KEY=AIzaSyTest123456789");
      expect(result).toContain(
        "VITE_FIREBASE_AUTH_DOMAIN=test-project.firebaseapp.com",
      );
      expect(result).toContain("VITE_FIREBASE_PROJECT_ID=test-project");
      expect(result).toContain(
        "VITE_FIREBASE_STORAGE_BUCKET=test-project.appspot.com",
      );
      expect(result).toContain("VITE_FIREBASE_MESSAGING_SENDER_ID=123456789");
      expect(result).toContain(
        "VITE_FIREBASE_APP_ID=1:123456789:web:abcdef123456",
      );
      expect(result).toContain("VITE_FIREBASE_MEASUREMENT_ID=G-ABCDEF1234");
    });

    it("should convert to staging .env format", () => {
      const result = convertToEnv(sampleConfig, "staging");

      expect(result).toContain("# Staging Environment");
      expect(result).toContain("VITE_FIREBASE_ENV=staging");
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_API_KEY=AIzaSyTest123456789",
      );
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_AUTH_DOMAIN=test-project.firebaseapp.com",
      );
      expect(result).toContain("VITE_FIREBASE_STAGING_PROJECT_ID=test-project");
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_STORAGE_BUCKET=test-project.appspot.com",
      );
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_MESSAGING_SENDER_ID=123456789",
      );
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_APP_ID=1:123456789:web:abcdef123456",
      );
      expect(result).toContain(
        "VITE_FIREBASE_STAGING_MEASUREMENT_ID=G-ABCDEF1234",
      );
    });

    it("should handle config without measurementId", () => {
      const configWithoutMeasurement = { ...sampleConfig };
      delete configWithoutMeasurement.measurementId;

      const result = convertToEnv(configWithoutMeasurement, "production");

      expect(result).toContain("VITE_FIREBASE_API_KEY=AIzaSyTest123456789");
      expect(result).not.toContain("VITE_FIREBASE_MEASUREMENT_ID");
    });

    it("should end with a newline", () => {
      const result = convertToEnv(sampleConfig, "production");
      expect(result.endsWith("\n")).toBe(true);
    });

    it("should produce valid .env format (no empty lines between values)", () => {
      const result = convertToEnv(sampleConfig, "production");
      const lines = result.split("\n");

      // Should have header, blank line, then values
      const valueLines = lines.filter((line) =>
        line.startsWith("VITE_FIREBASE_"),
      );
      expect(valueLines.length).toBeGreaterThan(0);

      // Each value line should have the format KEY=VALUE
      for (const line of valueLines) {
        expect(line).toMatch(/^VITE_FIREBASE_\w+=.+$/);
      }
    });
  });

  describe("Integration", () => {
    it("should process a complete Firebase config correctly", () => {
      const firebaseConfigJs = `
        const firebaseConfig = {
          apiKey: "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q",
          authDomain: "dobutsu-stationery-6b227.firebaseapp.com",
          projectId: "dobutsu-stationery-6b227",
          storageBucket: "dobutsu-stationery-6b227.appspot.com",
          messagingSenderId: "346660531589",
          appId: "1:346660531589:web:d04e079432b6434a7b28ec",
          measurementId: "G-QM2RSC0RC7"
        };
      `;

      const config = extractConfig(firebaseConfigJs);
      validateConfig(config);
      const envContent = convertToEnv(config, "production");

      expect(envContent).toContain(
        "VITE_FIREBASE_PROJECT_ID=dobutsu-stationery-6b227",
      );
      expect(envContent).toContain(
        "VITE_FIREBASE_API_KEY=AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q",
      );
    });

    it("should handle JSON format from Firebase Console", () => {
      const firebaseConfigJson = `{
        "apiKey": "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q",
        "authDomain": "dobutsu-stationery-6b227.firebaseapp.com",
        "projectId": "dobutsu-stationery-6b227",
        "storageBucket": "dobutsu-stationery-6b227.appspot.com",
        "messagingSenderId": "346660531589",
        "appId": "1:346660531589:web:d04e079432b6434a7b28ec",
        "measurementId": "G-QM2RSC0RC7"
      }`;

      const config = extractConfig(firebaseConfigJson);
      validateConfig(config);
      const envContent = convertToEnv(config, "staging");

      expect(envContent).toContain("VITE_FIREBASE_ENV=staging");
      expect(envContent).toContain(
        "VITE_FIREBASE_STAGING_PROJECT_ID=dobutsu-stationery-6b227",
      );
    });
  });
});
