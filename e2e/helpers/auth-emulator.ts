/**
 * Firebase Auth Emulator Helper for E2E Tests
 *
 * This helper provides utilities to authenticate users via the Firebase Auth Emulator
 * using the REST API. This allows e2e tests to properly sign in without mocking.
 */

import type { Page } from "@playwright/test";

export interface AuthUser {
	email: string;
	password: string;
	displayName?: string;
	uid?: string;
	idToken?: string;
	refreshToken?: string;
}

/**
 * Sign up a new user in the Firebase Auth Emulator
 */
export async function signUpWithEmailPassword(
	email: string,
	password: string,
	displayName?: string,
): Promise<AuthUser> {
	const response = await fetch(
		"http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				email,
				password,
				displayName: displayName || email.split("@")[0],
				returnSecureToken: true,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to sign up: ${error}`);
	}

	const data = await response.json();

	return {
		email,
		password,
		displayName: displayName || email.split("@")[0],
		uid: data.localId,
		idToken: data.idToken,
		refreshToken: data.refreshToken,
	};
}

/**
 * Sign in an existing user in the Firebase Auth Emulator
 */
export async function signInWithEmailPassword(
	email: string,
	password: string,
): Promise<AuthUser> {
	const response = await fetch(
		"http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				email,
				password,
				returnSecureToken: true,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Failed to sign in: ${error}`);
	}

	const data = await response.json();

	return {
		email: data.email,
		password,
		displayName: data.displayName,
		uid: data.localId,
		idToken: data.idToken,
		refreshToken: data.refreshToken,
	};
}

/**
 * Inject auth state into the browser's storage to authenticate the user
 *
 * This function injects the Firebase auth tokens into localStorage and IndexedDB
 * so that when the page loads, Firebase SDK recognizes the user as authenticated.
 */
export async function injectAuthState(page: Page, user: AuthUser) {
	// Wait for the page to be ready
	await page.waitForLoadState("domcontentloaded");

	// Inject auth state into the page
	await page.evaluate(
		({ user, projectId }) => {
			// Set up localStorage with auth user data
			const authKey = `firebase:authUser:demo-api-key:[DEFAULT]`;
			const authUser = {
				uid: user.uid,
				email: user.email,
				emailVerified: false,
				displayName: user.displayName || user.email.split("@")[0],
				isAnonymous: false,
				photoURL: null,
				providerData: [
					{
						providerId: "password",
						uid: user.email,
						displayName: user.displayName || user.email.split("@")[0],
						email: user.email,
						phoneNumber: null,
						photoURL: null,
					},
				],
				stsTokenManager: {
					refreshToken: user.refreshToken,
					accessToken: user.idToken,
					expirationTime: Date.now() + 3600000, // 1 hour from now
				},
				createdAt: String(Date.now()),
				lastLoginAt: String(Date.now()),
				apiKey: "demo-api-key",
				appName: "[DEFAULT]",
			};

			localStorage.setItem(authKey, JSON.stringify(authUser));

			console.log("✓ Auth state injected into localStorage");
		},
		{ user, projectId: "demo-test-project" },
	);
}

/**
 * Create a test user and sign in via the emulator
 *
 * This is the main helper function that:
 * 1. Creates a user in the auth emulator (or signs in if already exists)
 * 2. Injects the auth state into the browser
 */
export async function authenticateUser(
	page: Page,
	email: string = "test@example.com",
	password: string = "testpassword123",
	displayName?: string,
): Promise<AuthUser> {
	let user: AuthUser;

	try {
		// Try to sign up first
		user = await signUpWithEmailPassword(email, password, displayName);
		console.log(`✓ Created new test user: ${email}`);
	} catch (error) {
		// If sign up fails, try to sign in (user might already exist)
		try {
			user = await signInWithEmailPassword(email, password);
			console.log(`✓ Signed in existing test user: ${email}`);
		} catch (signInError) {
			throw new Error(
				`Failed to authenticate: ${error}\nSign in also failed: ${signInError}`,
			);
		}
	}

	// Inject the auth state into the browser
	// Navigate to the base URL first so localStorage is accessible
	await page.goto("/");
	await page.waitForLoadState("domcontentloaded");
	await injectAuthState(page, user);

	return user;
}

/**
 * Clear all auth state from the emulator (for cleanup between tests)
 */
export async function clearAuthEmulator(): Promise<void> {
	try {
		await fetch(
			"http://localhost:9099/emulator/v1/projects/demo-test-project/accounts",
			{
				method: "DELETE",
			},
		);
		console.log("✓ Cleared all users from Auth emulator");
	} catch (error) {
		console.warn("Failed to clear auth emulator:", error);
	}
}
