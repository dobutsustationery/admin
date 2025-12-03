#!/usr/bin/env node

/**
 * Pre-commit check to ensure no waitForTimeout calls exist in e2e tests
 * 
 * waitForTimeout is banned because it introduces arbitrary delays that make tests slow and flaky.
 * Use proper wait mechanisms like waitForLoadState, waitFor, or expect instead.
 */

import { execSync } from 'node:child_process';
import { exit } from 'node:process';

try {
  const result = execSync(
    'grep -r "waitForTimeout" e2e/ --include="*.ts" --include="*.js" -n || true',
    { encoding: 'utf-8' }
  );

  if (result.trim()) {
    console.error('❌ PRECOMMIT CHECK FAILED: waitForTimeout detected in e2e tests\n');
    console.error('waitForTimeout introduces arbitrary delays and is banned.');
    console.error('Use proper wait mechanisms instead:\n');
    console.error('  - page.waitForLoadState("domcontentloaded" | "networkidle")');
    console.error('  - element.waitFor({ state: "visible" | "hidden" })');
    console.error('  - expect(element).toBeVisible()');
    console.error('  - page.waitForSelector()');
    console.error('\nViolations found:\n');
    console.error(result);
    exit(1);
  }

  console.log('✅ No waitForTimeout calls found in e2e tests');
  exit(0);
} catch (error) {
  console.error('Error running check:', error.message);
  exit(1);
}
