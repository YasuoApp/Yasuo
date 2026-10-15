import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app"

import { FIREBASE_CONFIG } from "@shared/firebase"

/**
 * The one Firebase app the window uses, for both sign-in and the account's
 * cloud copy. Made on first use rather than at import, so a window that never
 * touches the account never starts the SDK.
 */
export function firebaseApp(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(FIREBASE_CONFIG)
}
