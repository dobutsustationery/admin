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
} from "firebase/firestore";
// Ensure Firestore module is fully loaded
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
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Create stub exports that will be replaced once Firebase is ready
let _auth: Auth;
let _firestore: Firestore | null = null;

// Initialize auth immediately (it works without delay)
try {
  _auth = getAuth(app);
  console.log("✅ Auth initialized");
} catch (error) {
  console.error("Auth initialization failed:", error);
}

// Initialize Firebase services asynchronously to avoid "Service not available" errors
// Auth is already initialized above, only initialize Firestore here
setTimeout(() => {
  try {
    // Only initialize firestore if not already done
    if (!_firestore) {
      _firestore = getFirestore(app);

      // Connect to emulators if in emulator mode
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

        console.log(
          `🔧 Connecting to Firestore emulator at ${firestoreHost}:${firestorePort}`,
        );
        console.log(`🔧 Connecting to Auth emulator at ${authHost}:${authPort}`);

        connectFirestoreEmulator(_firestore, firestoreHost, firestorePort);
        connectAuthEmulator(_auth, `http://${authHost}:${authPort}`, {
          disableWarnings: true,
        });

        console.log(`✅ Firebase emulators connected`);
      }
    }
  } catch (error) {
    console.error("Firebase initialization error:", error);
    // Retry with progressively longer delays
    const retryDelays = [100, 200, 500, 1000, 2000];
    let retryCount = 0;
    
    const retryInit = () => {
      try {
        if (!_firestore) {
          _firestore = getFirestore(app);
          console.log(`✅ Firestore initialized on retry ${retryCount + 1}`);
          
          // Connect to emulators if needed
          if (firebaseEnv === "local" && _firestore) {
            try {
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
              
              connectFirestoreEmulator(_firestore, firestoreHost, firestorePort);
              connectAuthEmulator(_auth, `http://${authHost}:${authPort}`, {
                disableWarnings: true,
              });
              console.log(`✅ Emulators connected on retry`);
            } catch (emulatorError) {
              // Already connected, ignore
            }
          }
        }
      } catch (retryError) {
        console.warn(`Firestore retry ${retryCount + 1} failed:`, retryError);
        retryCount++;
        if (retryCount < retryDelays.length) {
          setTimeout(retryInit, retryDelays[retryCount]);
        } else {
          console.error("Firestore initialization failed after all retries");
        }
      }
    };
    
    setTimeout(retryInit, retryDelays[0]);
  }
}, 100);

// Export auth directly (already initialized) or via getter if initialization failed
export const auth = _auth || new Proxy({} as Auth, {
  get: (_target, prop) => {
    if (!_auth) {
      try {
        _auth = getAuth(app);
      } catch (e) {
        console.warn("Auth not ready, returning undefined for", prop);
      }
    }
    return _auth ? (_auth as any)[prop] : undefined;
  }
});

export const firestore = new Proxy({} as Firestore, {
  get: (_target, prop) => {
    if (!_firestore) {
      // If not ready yet, initialize synchronously as fallback
      try {
        _firestore = getFirestore(app);
      } catch (e) {
        console.warn("Firestore not ready, returning undefined for", prop);
      }
    }
    return _firestore ? (_firestore as any)[prop] : undefined;
  }
});

export const googleAuthProvider = new GoogleAuthProvider();

// Export environment info for debugging
export const environment = firebaseEnv;
