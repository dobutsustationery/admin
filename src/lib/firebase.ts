import {
  connectAuthEmulator,
  GoogleAuthProvider,
  getAuth,
} from "firebase/auth";
import { initializeApp } from "firebase/app";
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
} from "firebase/firestore";

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
        "dobutsu-admin",
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

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
export const firestore = initializeFirestore(app, {
  localCache: persistentLocalCache(),
});

// Connect to emulators if in local environment
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

  connectFirestoreEmulator(firestore, firestoreHost, firestorePort);
  connectAuthEmulator(auth, `http://${authHost}:${authPort}`, {
    disableWarnings: true,
  });

  console.log(
    `🔧 Connected to Firestore emulator at ${firestoreHost}:${firestorePort}`,
  );
  console.log(`🔧 Connected to Auth emulator at ${authHost}:${authPort}`);
}

// Export environment info for debugging
export const environment = firebaseEnv;
