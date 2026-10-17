import type { H3Event } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { anthropicError } from "./anthropic.ts"
import {
  GOOGLE_JWKS,
  keysAt,
  tokenOf,
  verifyIdToken,
  type FirebaseUser,
} from "./firebase.ts"

/**
 * The signed-in studio user a request is from, or the 401 to answer with.
 *
 * Anthropic's own 401 `authentication_error`, so the CLI shows it as the
 * credential problem it is rather than as a server failure to retry.
 */
export async function authenticate(
  event: H3Event
): Promise<FirebaseUser | Response> {
  const token = tokenOf(event.req.headers)
  if (!token) {
    return anthropicError(
      401,
      "authentication_error",
      "Sign in to Visual Studio Claude to use the free AI."
    )
  }
  const config = useRuntimeConfig()
  const user = await verifyIdToken(
    token,
    config.firebaseProjectId,
    keysAt(config.firebaseJwksUrl || GOOGLE_JWKS)
  )
  return (
    user ??
    anthropicError(
      401,
      "authentication_error",
      "Your Visual Studio Claude sign-in has expired. Sign in again."
    )
  )
}
