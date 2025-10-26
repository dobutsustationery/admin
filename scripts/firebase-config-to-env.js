#!/usr/bin/env node

/**
 * Firebase Config to .env Converter
 *
 * This utility converts Firebase's standard web configuration object
 * into the .env file format used by this project.
 *
 * Usage:
 *   # Interactive mode (paste config)
 *   node scripts/firebase-config-to-env.js
 *
 *   # With environment flag (default is production)
 *   node scripts/firebase-config-to-env.js --env staging
 *   node scripts/firebase-config-to-env.js --env production
 *
 *   # From a file
 *   node scripts/firebase-config-to-env.js --input firebase-config.json
 *
 *   # Save directly to .env file
 *   node scripts/firebase-config-to-env.js --output .env.staging
 *
 * Input format (JavaScript or JSON):
 *   {
 *     "apiKey": "AIza...",
 *     "authDomain": "your-project.firebaseapp.com",
 *     "projectId": "your-project",
 *     "storageBucket": "your-project.appspot.com",
 *     "messagingSenderId": "123456789",
 *     "appId": "1:123456789:web:abc...",
 *     "measurementId": "G-ABC..."
 *   }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const VALID_ENVS = ["staging", "production"];

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    env: "production",
    input: null,
    output: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--env" || arg === "-e") {
      options.env = args[++i];
    } else if (arg === "--input" || arg === "-i") {
      options.input = args[++i];
    } else if (arg === "--output" || arg === "-o") {
      options.output = args[++i];
    }
  }

  return options;
}

// Show help message
function showHelp() {
  console.log(`
Firebase Config to .env Converter

This utility converts Firebase's standard web configuration object
into the .env file format used by this project.

Usage:
  node scripts/firebase-config-to-env.js [options]

Options:
  --env, -e <env>       Environment: staging or production (default: production)
  --input, -i <file>    Read Firebase config from a JSON file
  --output, -o <file>   Write output to a file instead of stdout
  --help, -h            Show this help message

Examples:
  # Interactive mode - paste your Firebase config
  node scripts/firebase-config-to-env.js

  # Generate staging environment file
  node scripts/firebase-config-to-env.js --env staging --output .env.staging

  # Convert from a JSON file
  node scripts/firebase-config-to-env.js --input firebase-config.json --env staging

Input format (JavaScript object or JSON):
  {
    "apiKey": "AIza...",
    "authDomain": "your-project.firebaseapp.com",
    "projectId": "your-project",
    "storageBucket": "your-project.appspot.com",
    "messagingSenderId": "123456789",
    "appId": "1:123456789:web:abc...",
    "measurementId": "G-ABC..."
  }

Or paste the JavaScript config directly:
  const firebaseConfig = {
    apiKey: "AIza...",
    authDomain: "your-project.firebaseapp.com",
    ...
  };
`);
}

// Extract Firebase config from various input formats
function extractConfig(input) {
  // Remove JavaScript variable declarations and comments
  const cleaned = input
    .replace(/\/\/.*$/gm, "") // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove multi-line comments
    .replace(/const\s+\w+\s*=\s*/, "") // Remove 'const variable ='
    .replace(/var\s+\w+\s*=\s*/, "") // Remove 'var variable ='
    .replace(/let\s+\w+\s*=\s*/, "") // Remove 'let variable ='
    .replace(/;[\s\n]*$/, "") // Remove trailing semicolon and whitespace
    .trim();

  // Try to parse as JSON
  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    // If JSON parse fails, try to evaluate as JavaScript object literal
    try {
      // Handle JavaScript object: quote unquoted keys
      // Only add quotes to keys that don't already have them
      const jsonStr = cleaned
        .replace(/'/g, '"') // Replace single quotes with double quotes
        .replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3'); // Quote unquoted keys
      return JSON.parse(jsonStr);
    } catch (_e2) {
      throw new Error(
        "Could not parse Firebase config. Please ensure it's valid JSON or JavaScript object.",
      );
    }
  }
}

// Validate Firebase config
function validateConfig(config) {
  const requiredFields = [
    "apiKey",
    "authDomain",
    "projectId",
    "storageBucket",
    "messagingSenderId",
    "appId",
  ];

  const missingFields = requiredFields.filter((field) => !config[field]);

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required fields: ${missingFields.join(", ")}\n` +
        "A valid Firebase config must include: " +
        requiredFields.join(", "),
    );
  }

  return true;
}

// Convert Firebase config to .env format
function convertToEnv(config, env) {
  const lines = [];

  // Add header comment
  if (env === "staging") {
    lines.push("# Staging Environment");
    lines.push("VITE_FIREBASE_ENV=staging");
    lines.push("");
    lines.push("# Firebase Configuration for Staging");
  } else {
    lines.push("# Production Environment");
    lines.push("VITE_FIREBASE_ENV=production");
    lines.push("");
    lines.push("# Firebase Configuration");
  }

  // Determine variable prefix based on environment
  const prefix =
    env === "staging" ? "VITE_FIREBASE_STAGING_" : "VITE_FIREBASE_";

  // Map Firebase config keys to environment variable names
  const keyMapping = {
    apiKey: `${prefix}API_KEY`,
    authDomain: `${prefix}AUTH_DOMAIN`,
    projectId: `${prefix}PROJECT_ID`,
    storageBucket: `${prefix}STORAGE_BUCKET`,
    messagingSenderId: `${prefix}MESSAGING_SENDER_ID`,
    appId: `${prefix}APP_ID`,
    measurementId: `${prefix}MEASUREMENT_ID`,
  };

  // Add each configuration value
  for (const [key, envVar] of Object.entries(keyMapping)) {
    if (config[key]) {
      lines.push(`${envVar}=${config[key]}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

// Read input from stdin
async function readStdin() {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(
      "Paste your Firebase config (JavaScript object or JSON) and press Ctrl+D when done:\n",
    );

    let input = "";
    rl.on("line", (line) => {
      input += `${line}\n`;
    });

    rl.on("close", () => {
      resolve(input);
    });
  });
}

// Main function
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  // Validate environment
  if (!VALID_ENVS.includes(options.env)) {
    console.error(
      `❌ Error: Invalid environment '${options.env}'. Valid options: ${VALID_ENVS.join(", ")}`,
    );
    process.exit(1);
  }

  try {
    // Read input
    let inputStr;
    if (options.input) {
      // Read from file
      console.log(`📖 Reading Firebase config from: ${options.input}`);
      inputStr = readFileSync(options.input, "utf-8");
    } else {
      // Read from stdin
      inputStr = await readStdin();
    }

    if (!inputStr.trim()) {
      console.error("❌ Error: No input provided");
      process.exit(1);
    }

    // Parse and validate config
    const config = extractConfig(inputStr);
    validateConfig(config);

    console.log(`✅ Successfully parsed Firebase config`);
    console.log(`   Project ID: ${config.projectId}`);
    console.log(`   Environment: ${options.env}\n`);

    // Convert to .env format
    const envContent = convertToEnv(config, options.env);

    // Output
    if (options.output) {
      // Write to file
      writeFileSync(options.output, envContent);
      console.log(`✅ Wrote .env configuration to: ${options.output}`);
      console.log(
        `\n💡 You can now use this file by running: npm run env:${options.env}`,
      );
    } else {
      // Write to stdout
      console.log("Generated .env configuration:");
      console.log("================================\n");
      console.log(envContent);
      console.log("================================\n");
      console.log(
        `💡 To save this to a file, run with: --output .env.${options.env}`,
      );
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// Export functions for testing
export { extractConfig, validateConfig, convertToEnv };
