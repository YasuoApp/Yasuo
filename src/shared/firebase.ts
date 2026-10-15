/**
 * The Firebase project the studio signs in to.
 *
 * Not a secret: a Web app's config identifies the project to Google and is
 * shipped to every browser that loads it. Access is decided by the project's
 * own rules and by which sign-in providers are switched on, not by hiding this.
 *
 * Shared because both sides need it: the renderer initialises the SDK with it,
 * and the sign-in page the main process serves on localhost initialises the
 * same SDK with the same project.
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBzXBIKcX4_ZUDGinPNMnvv3z1H9jLwvnA",
  authDomain: "simm-chat.firebaseapp.com",
  projectId: "simm-chat",
  storageBucket: "simm-chat.firebasestorage.app",
  messagingSenderId: "935344658250",
  appId: "1:935344658250:web:9a1324c3113f3a341953b3",
  measurementId: "G-1ZFC8DPRV0",
}

/**
 * The version of the Firebase JS SDK the sign-in page loads from the CDN — the
 * same one `firebase` in `package.json` resolves to, so the page and the
 * renderer agree about the protocol. Bump both together.
 */
export const FIREBASE_SDK_VERSION = "13.0.0"

/** The reason a sign-in ends when the user cancels it, rather than failing.
 * Shared so the renderer can tell it apart from a real error and not show it. */
export const SIGN_IN_CANCELLED = "Sign-in was cancelled."
