import { getSetting, setSetting } from "./workspace"

/**
 * Reading and writing which tabs a panel had open.
 *
 * The Terminal panel remembered its sessions and no other panel remembered
 * anything, so a reload emptied four of the five strips while Terminal came
 * back intact. Each panel still owns *what* it writes — what identifies a tab
 * is the panel's own business, a schema-qualified name here and a capture id
 * there — and this is only the part that was the same four times over.
 *
 * Writes are fire-and-forget, like the Terminal store's: clicking a tab is not
 * worth blocking on a settings write, and a lost one costs a tab's position
 * next launch and nothing else.
 */
export function remember(key: string, value: unknown): void {
  void setSetting(key, JSON.stringify(value)).catch((error) => {
    console.error(`Could not save open tabs (${key})`, error)
  })
}

/**
 * Null when nothing is stored, when it does not parse, or when it is not the
 * shape this build expects — what an older build wrote is dropped rather than
 * repaired, the way `isRememberedSession` treats a stale session entry.
 */
export async function recall<T>(
  key: string,
  isValid: (value: unknown) => value is T
): Promise<T | null> {
  let raw: string | null
  try {
    raw = await getSetting(key)
  } catch (error) {
    console.error(`Could not read open tabs (${key})`, error)
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : null
  } catch {
    // A settings value is a file on disk; a half-written one is not a crash.
    return null
  }
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

/** The `{ openIds, selectedId }` pair the API and capture panels both store. */
export type RememberedTabs = {
  openIds: string[]
  selectedId: string | null
}

export function isRememberedTabs(value: unknown): value is RememberedTabs {
  const record = value as Partial<RememberedTabs> | null
  return (
    isStringArray(record?.openIds) &&
    (record.selectedId === null || typeof record.selectedId === "string")
  )
}
