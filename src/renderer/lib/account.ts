import { initializeApp } from "firebase/app"
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut,
  type Auth,
} from "firebase/auth"
import { create } from "zustand"

import { FIREBASE_CONFIG, SIGN_IN_CANCELLED } from "@shared/firebase"

/**
 * Who is signed in to the studio, through Firebase.
 *
 * Firebase keeps the session in this window's own storage, so it survives a
 * relaunch; `watchAccount` only has to listen to it. Signing in is the one
 * thing that needs the main process: the Google page has to open in the
 * user's browser (`main/google-sign-in.ts`), and what comes back is the Google
 * ID token that `signInWithCredential` exchanges here.
 */

/** Only what Settings shows. Not the Firebase `User`, which carries a token
 * refresh and methods a settings row has no use for. */
export type Account = {
  email: string | null
  name: string | null
  photo: string | null
}

type AccountState = {
  /** False until Firebase has said whether anybody is signed in — before that,
   * neither "signed in" nor "signed out" is true. */
  ready: boolean
  account: Account | null
  /** A sign-in is waiting on the browser, or a sign-out is running. */
  busy: boolean
  error: string | null
  signIn: () => Promise<void>
  /** Ends a sign-in waiting on the browser. The waiting `signIn` then returns
   * quietly, since a cancel is what the user asked for. */
  cancelSignIn: () => Promise<void>
  signOut: () => Promise<void>
}

let auth: Auth | null = null

/** One Firebase app for the window, made on first use rather than at import,
 * so a window that never opens Settings never starts the SDK. */
function authOf(): Auth {
  auth ??= getAuth(initializeApp(FIREBASE_CONFIG))
  return auth
}

let watching = false

/** Starts listening to Firebase for who is signed in. Idempotent: every caller
 * asks for it, and only the first one listens. */
export function watchAccount(): void {
  if (watching) return
  watching = true
  onAuthStateChanged(authOf(), (user) => {
    useAccount.setState({
      ready: true,
      account: user
        ? { email: user.email, name: user.displayName, photo: user.photoURL }
        : null,
    })
  })
}

export const useAccount = create<AccountState>()((set) => ({
  ready: false,
  account: null,
  busy: false,
  error: null,

  signIn: async () => {
    set({ busy: true, error: null })
    try {
      const idToken = await window.desktop.signInWithGoogle()
      await signInWithCredential(
        authOf(),
        GoogleAuthProvider.credential(idToken)
      )
      set({ busy: false })
    } catch (error) {
      const message = messageOf(error)
      set({
        busy: false,
        error: message === SIGN_IN_CANCELLED ? null : message,
      })
    }
  },

  cancelSignIn: async () => {
    await window.desktop.cancelSignInWithGoogle()
  },

  signOut: async () => {
    set({ busy: true, error: null })
    try {
      await signOut(authOf())
      set({ busy: false })
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
    }
  },
}))

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
