import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose"

/**
 * Who a request is from: the Firebase ID token the studio sends with it.
 *
 * Verified against Google's published keys rather than through
 * `firebase-admin`: an ID token is a JWT signed by `securetoken`, and checking
 * one needs the project id and the public keys — no service account, no SDK
 * that pulls in half of Google Cloud. The checks are the ones Firebase
 * documents for verifying an ID token with a third-party JWT library.
 */

export const GOOGLE_JWKS =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"

const remoteKeys = new Map<string, JWTVerifyGetKey>()

/** A key set fetched on first use and cached by `jose` per its headers —
 * Google's, unless the server is configured with another for a test. */
export function keysAt(url: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(url)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(url))
    remoteKeys.set(url, keys)
  }
  return keys
}

export type FirebaseUser = { uid: string; email: string | null }

/**
 * The user a token belongs to, or null for one that is not a live ID token of
 * this project — expired, signed by anything else, or minted for another app.
 *
 * `keys` is Google's unless a test signs its own.
 */
export async function verifyIdToken(
  token: string,
  projectId: string,
  keys: JWTVerifyGetKey = keysAt(GOOGLE_JWKS)
): Promise<FirebaseUser | null> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
      algorithms: ["RS256"],
    })
    // `sub` is the uid; Firebase guarantees it non-empty, and a token without
    // one is not a user this server can meter.
    if (typeof payload.sub !== "string" || payload.sub === "") return null
    if (
      typeof payload.auth_time === "number" &&
      payload.auth_time * 1000 > Date.now() + 60_000
    ) {
      return null
    }
    return {
      uid: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
    }
  } catch {
    return null
  }
}

/**
 * The token out of a request: `Authorization: Bearer …` or `x-api-key`. The
 * studio's `claude` sends both (an `apiKeyHelper`'s output goes out as each),
 * and either alone is enough.
 */
export function tokenOf(headers: Headers): string | null {
  const bearer = headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]
  const token = bearer ?? headers.get("x-api-key")
  return token?.trim() || null
}
