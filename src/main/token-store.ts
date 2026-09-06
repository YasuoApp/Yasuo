import { safeStorage } from "electron"

/**
 * The one secret this app keeps: a ClickUp personal key.
 *
 * Its own module, small as it is, for the reason `data-dir.ts` is one — this is
 * where `electron` gets imported, so `store.ts` stays a plain JSON store that a
 * test running under `bun` can reach. The **manifest** holds the ciphertext,
 * through the ordinary `settings` map: a second file for one string would be a
 * second thing to keep in step with a manifest that is rewritten whole anyway.
 *
 * `safeStorage` is the OS's own store behind it — the Keychain on macOS — so
 * what lands in `manifest.json` is bytes that only this user on this machine
 * can read back. On a desktop with no keyring `isEncryptionAvailable()` is
 * false, and `seal` **refuses** rather than writing the key in plain text: a
 * token written where anything on the machine can read it, in a file the user
 * has no reason to look in, is worse than a feature that says it is
 * unavailable.
 */

export type Sealed = { value: string } | { error: string }

export function seal(secret: string): Sealed {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      error:
        "This machine has no secure key store, so the ClickUp key cannot be saved.",
    }
  }
  return { value: safeStorage.encryptString(secret).toString("base64") }
}

/**
 * The key back, or empty for one that cannot be read.
 *
 * Unreadable rather than throwing is the right answer for every way this fails
 * in practice — the manifest copied to another machine, the keyring reset — and
 * all of them mean the same thing to the caller: there is no key, ask for one
 * again.
 */
export function unseal(stored: string | null): string {
  if (!stored) return ""
  if (!safeStorage.isEncryptionAvailable()) return ""
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"))
  } catch {
    return ""
  }
}
