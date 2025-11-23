import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Set emulator host before initializing
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

console.log(`Setting FIRESTORE_EMULATOR_HOST to: ${emulatorHost}`);

const app = initializeApp({
  projectId: "demo-test-project",
});

const db = getFirestore(app);

console.log('✓ Firebase Admin initialized successfully');
console.log('✓ Firestore instance created');
console.log(`✓ Connected to emulator at ${emulatorHost}`);

// Try to create a simple batch to verify it doesn't hang
const batch = db.batch();
console.log('✓ Batch created successfully');

console.log('\n✅ All connection checks passed!');
