import {
  type Auth,
  connectAuthEmulator,
  GoogleAuthProvider,
  getAuth,
} from "firebase/auth";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  type Firestore,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
} from "firebase/firestore";
// Force Firestore component registration by importing the module
import "firebase/firestore";

// Get environment mode from environment variables
// Possible values: 'local' | 'staging' | 'production'
const firebaseEnv = import.meta.env.VITE_FIREBASE_ENV || "production";

// Get Firebase configuration based on environment
function getFirebaseConfig() {
  if (firebaseEnv === "local") {
    // For local emulators, we need a minimal config with project ID
    return {
      apiKey: "demo-api-key",
      authDomain: "localhost",
      projectId:
        import.meta.env.VITE_FIREBASE_LOCAL_PROJECT_ID ||
        "dobutsu-stationery-6b227",
      storageBucket: "demo-storage-bucket",
      messagingSenderId: "demo-sender-id",
      appId: "demo-app-id",
    };
  } else if (firebaseEnv === "staging") {
    // Staging environment configuration
    return {
      apiKey: import.meta.env.VITE_FIREBASE_STAGING_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_STAGING_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_STAGING_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STAGING_STORAGE_BUCKET,
      messagingSenderId: import.meta.env
        .VITE_FIREBASE_STAGING_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FIREBASE_STAGING_APP_ID,
      measurementId: import.meta.env.VITE_FIREBASE_STAGING_MEASUREMENT_ID,
    };
  } else {
    // Production environment configuration (fallback to hardcoded values if env vars not set)
    return {
      apiKey:
        import.meta.env.VITE_FIREBASE_API_KEY ||
        "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q",
      authDomain:
        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ||
        "dobutsu-stationery-6b227.firebaseapp.com",
      projectId:
        import.meta.env.VITE_FIREBASE_PROJECT_ID || "dobutsu-stationery-6b227",
      storageBucket:
        import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ||
        "dobutsu-stationery-6b227.appspot.com",
      messagingSenderId:
        import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "346660531589",
      appId:
        import.meta.env.VITE_FIREBASE_APP_ID ||
        "1:346660531589:web:d04e079432b6434a7b28ec",
      measurementId:
        import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-QM2RSC0RC7",
    };
  }
}

const firebaseConfig = getFirebaseConfig();

console.log(`🔥 Firebase Environment: ${firebaseEnv}`);
console.log(`📦 Firebase Project: ${firebaseConfig.projectId}`);

// Check if app is already initialized (for HMR)
console.log("DEBUG: About to initialize Firebase app");
console.log("DEBUG: getApps().length = " + getApps().length);
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
console.log("DEBUG: Firebase app initialized, app.name = " + app.name);

let auth: Auth;
let firestore: Firestore;

// Check if we're in emulator mode  
if (firebaseEnv === "local") {
  const firestoreHost =
    import.meta.env.VITE_EMULATOR_FIRESTORE_HOST || "localhost";
  const firestorePort = Number.parseInt(
    import.meta.env.VITE_EMULATOR_FIRESTORE_PORT || "8080",
    10,
  );
  const authHost = import.meta.env.VITE_EMULATOR_AUTH_HOST || "localhost";
  const authPort = Number.parseInt(
    import.meta.env.VITE_EMULATOR_AUTH_PORT || "9099",
    10,
  );

  console.log("DEBUG: About to log emulator connection info");
  console.log(
    `🔧 Connecting to Firestore emulator at ${firestoreHost}:${firestorePort}`,
  );
  console.log(`🔧 Connecting to Auth emulator at ${authHost}:${authPort}`);
  console.log("DEBUG: After logging emulator info, before Firestore init");
  console.log("🔧 About to initialize Firestore...");
  console.log("DEBUG: About to call getFirestore");

  // Initialize Firestore and connect to emulator
  // Use getFirestore to get the default instance, then connect to emulator
  // connectFirestoreEmulator must be called before any Firestore operations
  try {
    firestore = getFirestore(app);
    console.log("DEBUG: getFirestore succeeded");
    connectFirestoreEmulator(firestore, firestoreHost, firestorePort);
    console.log("📦 Initialized Firestore with emulator connection");
  } catch (error) {
    console.error("❌ ERROR during Firestore initialization:", error);
    throw error;
  }
  console.log("✅ Firestore initialized successfully");

  auth = getAuth(app);
  
  // connectAuthEmulator can be called multiple times safely
  try {
    connectAuthEmulator(auth, `http://${authHost}:${authPort}`, {
      disableWarnings: true,
    });
  } catch (e) {
    // Already connected, ignore
    console.log("🔧 Auth emulator already connected");
  }

  console.log("✅ Firebase emulators ready");
} else {
  // Production/staging mode
  try {
    firestore = getFirestore(app);
  } catch {
    firestore = initializeFirestore(app, {
      localCache: persistentLocalCache(),
    });
  }
  auth = getAuth(app);
}

export const googleAuthProvider = new GoogleAuthProvider();
export { auth, firestore };

// Export environment info for debugging
export const environment = firebaseEnv;
