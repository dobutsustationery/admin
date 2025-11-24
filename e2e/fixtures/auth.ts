import { test as base, expect } from "@playwright/test";

/**
 * Custom fixture for authenticated tests
 *
 * This fixture creates a real user in the Firebase Auth Emulator
 * and injects valid auth state into localStorage before the page loads.
 */

type AuthFixtures = {
  authenticatedPage: any;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page, context }, use) => {
    // Create a real user in Firebase Auth Emulator using Playwright's request context
    const authEmulatorUrl = "http://localhost:9099";
    const testEmail = `test-${Date.now()}@example.com`; // Unique email to avoid conflicts
    const testPassword = "testpassword123";
    
    let authData = null;
    
    try {
      // Create user via Auth emulator REST API using Playwright's request
      const response = await page.request.post(
        `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
        {
          data: {
            email: testEmail,
            password: testPassword,
            displayName: "Test User",
            returnSecureToken: true,
          },
        }
      );
      
      if (response.ok()) {
        authData = await response.json();
        console.log(`✓ Created test user in Auth emulator: ${authData.email}`);
      } else {
        console.log(`⚠️  Failed to create user: ${response.status()}`);
      }
    } catch (error) {
      console.log(`⚠️  Error creating user:`, error);
    }
    
    if (authData && authData.idToken) {
      // Inject real auth state into localStorage before page loads
      await context.addInitScript((authInfo) => {
        const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
        localStorage.setItem(
          authKey,
          JSON.stringify({
            uid: authInfo.localId,
            email: authInfo.email,
            emailVerified: false,
            displayName: "Test User",
            isAnonymous: false,
            photoURL: null,
            providerData: [
              {
                providerId: "password",
                uid: authInfo.localId,
                displayName: "Test User",
                email: authInfo.email,
                phoneNumber: null,
                photoURL: null,
              },
            ],
            stsTokenManager: {
              refreshToken: authInfo.refreshToken,
              accessToken: authInfo.idToken,
              expirationTime: Date.now() + 3600000, // 1 hour from now
            },
            createdAt: String(Date.now()),
            lastLoginAt: String(Date.now()),
            apiKey: "demo-api-key",
            appName: "[DEFAULT]",
          }),
        );
        console.log("✓ Auth state injected into localStorage");
      }, authData);
    } else {
      console.log("⚠️  No auth data available, test will run unauthenticated");
    }

    await use(page);
  },
});

export { expect };
