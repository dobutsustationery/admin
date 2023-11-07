import { GoogleAuthProvider, getAuth } from "@firebase/auth";
import { initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey: "AIzaSyCSTJm9VL7MBNP6gfScxv7mvuAz2OFoh-Q",
  authDomain: "dobutsu-stationery-6b227.firebaseapp.com",
  projectId: "dobutsu-stationery-6b227",
  storageBucket: "dobutsu-stationery-6b227.appspot.com",
  messagingSenderId: "346660531589",
  appId: "1:346660531589:web:d04e079432b6434a7b28ec",
  measurementId: "G-QM2RSC0RC7",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleAuthProvider = new GoogleAuthProvider();
