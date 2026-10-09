import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signOut
} from 'firebase/auth';

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID
};

const requiredConfig = ['apiKey', 'authDomain', 'projectId', 'appId'];
let services;
let database;

export function isFirebaseConfigured() {
  return requiredConfig.every(key => typeof config[key] === 'string' && config[key].trim());
}

export function getFirebaseServices() {
  if (!isFirebaseConfigured()) throw new Error('Firebase 尚未配置');
  if (services) return services;

  const app = getApps().length ? getApp() : initializeApp(config);
  const auth = getAuth(app);
  auth.languageCode = 'zh-CN';

  services = { app, auth };
  return services;
}

export async function getFirebaseDatabase(app) {
  if (database) return database;
  const { getFirestore } = await import('firebase/firestore');
  // The app's own local ledger is the offline queue; avoid a second persistent
  // copy of financial records in Firestore's browser cache.
  database = getFirestore(app);
  return database;
}

export async function prepareEmailAuth(auth) {
  await setPersistence(auth, browserLocalPersistence);
}

export const observeAuth = onAuthStateChanged;
export const createEmailAccount = createUserWithEmailAndPassword;
export const signInWithEmail = signInWithEmailAndPassword;
export const sendVerificationEmail = sendEmailVerification;
export const requestPasswordReset = sendPasswordResetEmail;
export const signOutAccount = signOut;
