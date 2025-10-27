#!/usr/bin/env node

/**
 * Post-install script to install platform-specific Biome CLI packages
 * This is necessary because we omit optional dependencies to avoid npm install hangs,
 * but we need the platform-specific Biome packages for the linter to work.
 */

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Prevent recursive execution
if (process.env.SKIP_BIOME_INSTALL === 'true') {
  process.exit(0);
}

const BIOME_VERSION = '1.9.4';

// Determine the platform-specific package name
function getPlatformPackage() {
  const platform = os.platform();
  const arch = os.arch();
  
  const packageMap = {
    'darwin-arm64': '@biomejs/cli-darwin-arm64',
    'darwin-x64': '@biomejs/cli-darwin-x64',
    'linux-arm64': '@biomejs/cli-linux-arm64',
    'linux-x64': '@biomejs/cli-linux-x64',
    'win32-arm64': '@biomejs/cli-win32-arm64',
    'win32-x64': '@biomejs/cli-win32-x64',
  };
  
  const key = `${platform}-${arch}`;
  return packageMap[key];
}

function isPackageInstalled(packageName) {
  const packagePath = path.join(__dirname, '..', 'node_modules', packageName);
  return fs.existsSync(packagePath);
}

function main() {
  const platformPackage = getPlatformPackage();
  
  if (!platformPackage) {
    console.warn(`Warning: No Biome CLI package available for ${os.platform()}-${os.arch()}`);
    console.warn('The linter may not work correctly.');
    return;
  }
  
  if (isPackageInstalled(platformPackage.replace('@biomejs/', '@biomejs/'))) {
    console.log(`✓ ${platformPackage} is already installed`);
    return;
  }
  
  console.log(`Installing ${platformPackage}@${BIOME_VERSION} for your platform...`);
  
  try {
    execSync(`npm install --no-save --ignore-scripts ${platformPackage}@${BIOME_VERSION}`, {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, SKIP_BIOME_INSTALL: 'true' }
    });
    console.log(`✓ Successfully installed ${platformPackage}`);
  } catch (error) {
    console.error(`Failed to install ${platformPackage}:`, error.message);
    console.error('The linter may not work correctly.');
    process.exit(0); // Don't fail the installation
  }
}

main();
