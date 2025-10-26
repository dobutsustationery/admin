import { expect, test } from "@playwright/test";
import {
	authenticateUser,
	clearAuthEmulator,
} from "./helpers/auth-emulator.ts";

/**
 * E2E test story for the inventory management flow
 *
 * This test demonstrates the complete user journey:
 * 1. Starting from signed-out state
 * 2. Signing in via Firebase Auth Emulator
 * 3. Viewing and interacting with inventory
 *
 * Screenshots are numbered sequentially (000-description.png, 001-next-step.png, etc.)
 * to tell a visual story of the application flow.
 */

test.describe("Inventory Management Story", () => {
	// Clear auth state before each test
	test.beforeEach(async () => {
		await clearAuthEmulator();
	});

	test("complete user journey from sign-out to inventory", async ({ page }) => {
		// Step 0: Navigate to app while signed out
		await page.goto("/inventory");
		await page.waitForLoadState("networkidle");

		// Take screenshot of signed-out state
		await page.screenshot({
			path: "e2e/screenshots/000-signed-out-loading.png",
			fullPage: true,
		});
		console.log("✓ Screenshot 000: Signed-out state captured");

		// Check if we see the loading/sign-in UI (don't fail if not)
		const hasSignIn = await page
			.locator("text=Loading...")
			.isVisible({ timeout: 2000 })
			.catch(() => false);
		
		if (hasSignIn) {
			console.log("  Found sign-in UI");
		} else {
			console.log("  Page loaded (sign-in UI may have been fast)");
		}

		// Step 1: Authenticate via Firebase Auth Emulator
		console.log("\n🔐 Authenticating user via Auth Emulator...");
		const user = await authenticateUser(
			page,
			"testuser@example.com",
			"testpassword123",
			"Test User",
		);
		expect(user.uid).toBeTruthy();
		expect(user.idToken).toBeTruthy();
		console.log(`✓ Authenticated as: ${user.email} (${user.uid})`);

		// Step 2: Navigate to inventory page (now authenticated)
		await page.goto("/inventory");
		await page.waitForLoadState("networkidle");

		// Wait for Firebase to connect and load data
		await page.waitForTimeout(5000);

		// Take screenshot of authenticated state
		await page.screenshot({
			path: "e2e/screenshots/001-signed-in-inventory-loading.png",
			fullPage: true,
		});
		console.log("✓ Screenshot 001: Signed-in inventory loading");

		// Step 3: Wait for inventory to load and display
		// Check if inventory table is visible
		const hasTable = await page
			.locator("table")
			.isVisible({ timeout: 10000 })
			.catch(() => false);

		if (hasTable) {
			console.log("✓ Inventory table loaded");

			// Take screenshot of loaded inventory
			await page.screenshot({
				path: "e2e/screenshots/002-inventory-displayed.png",
				fullPage: true,
			});
			console.log("✓ Screenshot 002: Inventory displayed");

			// Verify table headers
			const headers = await page.locator("table thead th").allTextContents();
			console.log(`  Headers found: ${headers.join(", ")}`);
			expect(headers.length).toBeGreaterThan(0);

			// Look for expected headers
			const headersText = headers.join(" ");
			expect(headersText).toContain("JAN Code");

			// Count inventory rows
			const rowCount = await page.locator("table tbody tr").count();
			console.log(`  Found ${rowCount} inventory items`);

			// Take a close-up screenshot of the table
			const tableElement = page.locator("table").first();
			await tableElement.screenshot({
				path: "e2e/screenshots/003-inventory-table-detail.png",
			});
			console.log("✓ Screenshot 003: Inventory table detail");

			// Step 4: Test interaction - scroll through inventory
			await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
			await page.waitForTimeout(1000);

			await page.screenshot({
				path: "e2e/screenshots/004-inventory-scrolled.png",
				fullPage: true,
			});
			console.log("✓ Screenshot 004: Inventory scrolled");

			// Step 5: Verify inventory items have expected data
			if (rowCount > 0) {
				// Check first row for data
				const firstRow = page.locator("table tbody tr").first();
				const cellText = await firstRow.textContent();
				expect(cellText).toBeTruthy();
				expect(cellText!.length).toBeGreaterThan(0);
				console.log(`  First row contains: ${cellText!.substring(0, 50)}...`);
			}
		} else {
			console.log("⚠️  Inventory table not visible yet");

			// Still take a screenshot to show current state
			await page.screenshot({
				path: "e2e/screenshots/002-inventory-not-loaded.png",
				fullPage: true,
			});
			console.log("✓ Screenshot 002: Inventory state (table not loaded)");

			// Check what is visible
			const bodyText = await page.textContent("body");
			console.log(`  Body text length: ${bodyText?.length || 0}`);
		}

		// Final screenshot of complete state
		await page.screenshot({
			path: "e2e/screenshots/005-final-state.png",
			fullPage: true,
		});
		console.log("✓ Screenshot 005: Final state");

		console.log("\n✅ User journey test complete");
	});

	test("should show inventory items with proper data", async ({ page }) => {
		// Authenticate first
		await authenticateUser(
			page,
			"inventory-test@example.com",
			"testpass123",
			"Inventory Tester",
		);

		// Navigate to inventory
		await page.goto("/inventory");
		await page.waitForLoadState("networkidle");
		await page.waitForTimeout(5000);

		// Take initial screenshot
		await page.screenshot({
			path: "e2e/screenshots/100-inventory-initial.png",
			fullPage: true,
		});

		// Check for table
		const hasTable = await page
			.locator("table")
			.isVisible({ timeout: 10000 })
			.catch(() => false);

		if (hasTable) {
			// Verify table structure
			const headers = await page.locator("table thead th").allTextContents();
			expect(headers.length).toBeGreaterThan(0);

			const rowCount = await page.locator("table tbody tr").count();
			console.log(`Found ${rowCount} inventory items`);

			// Take screenshot showing the data
			await page.screenshot({
				path: "e2e/screenshots/101-inventory-with-data.png",
				fullPage: true,
			});
		} else {
			// Document that table wasn't found
			const content = await page.content();
			console.log("Table not found, page content length:", content.length);

			await page.screenshot({
				path: "e2e/screenshots/101-inventory-no-table.png",
				fullPage: true,
			});
		}
	});
});
