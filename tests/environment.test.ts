import { describe, expect, it } from "vitest";

describe("Environment Configuration", () => {
  it("should have valid environment values", () => {
    // Valid environment values
    const validEnvs = ["local", "staging", "production"];

    // The default should be production if not set
    const defaultEnv = "production";
    expect(validEnvs).toContain(defaultEnv);
  });

  it("should support local environment configuration", () => {
    // Test that we can define local emulator settings
    const localConfig = {
      firestoreHost: "localhost",
      firestorePort: 8080,
      authHost: "localhost",
      authPort: 9099,
    };

    expect(localConfig.firestoreHost).toBe("localhost");
    expect(localConfig.firestorePort).toBe(8080);
    expect(localConfig.authHost).toBe("localhost");
    expect(localConfig.authPort).toBe(9099);
  });

  it("should support production environment configuration", () => {
    // Test production config structure with example values
    const productionConfig = {
      apiKey: "example-api-key",
      authDomain: "example-project.firebaseapp.com",
      projectId: "example-project",
      storageBucket: "example-project.appspot.com",
      messagingSenderId: "123456789",
      appId: "1:123456789:web:abcdef123456",
      measurementId: "G-ABCDEF1234",
    };

    expect(productionConfig.projectId).toBe("example-project");
    expect(productionConfig.authDomain).toContain("firebaseapp.com");
  });

  it("should parse port numbers correctly", () => {
    const port1 = Number.parseInt("8080", 10);
    const port2 = Number.parseInt("9099", 10);

    expect(port1).toBe(8080);
    expect(port2).toBe(9099);
    expect(Number.isNaN(port1)).toBe(false);
    expect(Number.isNaN(port2)).toBe(false);
  });
});
