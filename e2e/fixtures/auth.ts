import { test as base, expect } from '@playwright/test';

/**
 * Custom fixture for authenticated tests
 * 
 * This fixture mocks Firebase authentication by injecting auth state
 * into localStorage before the page loads.
 */

type AuthFixtures = {
  authenticatedPage: any;
};

export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page, context }, use) => {
    // Mock Firebase auth state in localStorage
    await context.addInitScript(() => {
      // Mock user data
      const mockUser = {
        uid: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        photoURL: 'https://via.placeholder.com/150',
        emailVerified: true,
      };

      // Set up mock auth state in localStorage
      // This mimics what Firebase Auth would store
      const authKey = 'firebase:authUser:demo-api-key:[DEFAULT]';
      localStorage.setItem(authKey, JSON.stringify({
        uid: mockUser.uid,
        email: mockUser.email,
        emailVerified: mockUser.emailVerified,
        displayName: mockUser.displayName,
        isAnonymous: false,
        photoURL: mockUser.photoURL,
        providerData: [{
          providerId: 'google.com',
          uid: mockUser.uid,
          displayName: mockUser.displayName,
          email: mockUser.email,
          phoneNumber: null,
          photoURL: mockUser.photoURL,
        }],
        stsTokenManager: {
          refreshToken: 'mock-refresh-token',
          accessToken: 'mock-access-token',
          expirationTime: Date.now() + 3600000, // 1 hour from now
        },
        createdAt: String(Date.now()),
        lastLoginAt: String(Date.now()),
        apiKey: 'demo-api-key',
        appName: '[DEFAULT]',
      }));

      // Also set a flag that our app can check
      localStorage.setItem('e2e-test-authenticated', 'true');
      localStorage.setItem('e2e-test-user', JSON.stringify(mockUser));
    });

    await use(page);
  },
});

export { expect };
