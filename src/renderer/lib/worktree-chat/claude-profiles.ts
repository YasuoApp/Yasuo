import { create } from "zustand"

import type { ClaudeAccount, ClaudeProfile } from "@shared/api"

/**
 * The workspace's `CLAUDE_CONFIG_DIR` profiles — see `ClaudeProfile`.
 *
 * A view of `store.ts`'s own file, the same relationship `useApi`'s
 * `environments` has to `environments.json`: this holds the list, Settings'
 * Claude section edits it, and the composer's profile picker reads it. Loaded
 * once at launch (`studio.tsx`, beside `useWorktreeChats.refresh`) rather than
 * per composer mount, since several chats' toolbars read the same list.
 */
type ClaudeProfilesState = {
  profiles: ClaudeProfile[]
  loading: boolean
  /**
   * What each directory's login turned out to be, **keyed by the directory
   * rather than by the profile**: two profiles pointing at one directory are
   * one account, and a rename changes nothing about it. A directory nothing has
   * asked about yet simply misses the map, which is the honest answer rather
   * than some other directory's status under this profile's name.
   *
   * The empty string is the default login, the one a chat with no profile
   * picked runs under.
   */
  accounts: Record<string, ClaudeAccount>
  /** Directories with a check in flight, so a row can say so and a second
   * click cannot start a second `claude`. */
  checking: string[]

  refresh: () => Promise<void>
  /** Asks `claude` who that directory is signed in as — see `claudeAccount`. */
  check: (configDir: string) => Promise<void>
  /**
   * The same, for whichever of those directories has no answer yet.
   *
   * What the composer's picker opens with: a menu of four profiles must not be
   * four `claude` processes every time it is opened, and a login does not
   * change while somebody is deciding which one to send a message as. The
   * answer is held for the run and re-asked only where somebody asked for it —
   * the Check button in Settings.
   */
  checkUnknown: (configDirs: string[]) => void
  /**
   * A new profile — a name and nothing else.
   *
   * Its directory is main's to name (`main/claude-profiles.ts`), which is why
   * this does not take one and there is no setter for it below: the path is
   * under the store's own workspace directory, and `VSCLAUDE_DATA_DIR` can move
   * that somewhere this side cannot see.
   */
  create: (name: string) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
}

export const useClaudeProfiles = create<ClaudeProfilesState>((set, get) => ({
  profiles: [],
  loading: false,
  accounts: {},
  checking: [],

  async check(configDir) {
    const key = configDir.trim()
    if (get().checking.includes(key)) return

    set({ checking: [...get().checking, key] })
    try {
      const account = await window.desktop.claudeAccount(key)
      set({ accounts: { ...get().accounts, [key]: account } })
    } catch (error) {
      console.error("Could not check the Claude account", error)
      set({
        accounts: {
          ...get().accounts,
          [key]: {
            configDir: key,
            state: "error",
            email: null,
            organization: null,
            method: null,
            plan: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      })
    } finally {
      set({ checking: get().checking.filter((dir) => dir !== key) })
    }
  },

  checkUnknown(configDirs) {
    const { accounts, check } = get()
    for (const dir of new Set(configDirs.map((dir) => dir.trim()))) {
      if (!(dir in accounts)) void check(dir)
    }
  },

  async refresh() {
    set({ loading: true })
    try {
      set({
        profiles: await window.desktop.listClaudeProfiles(),
        loading: false,
      })
    } catch (error) {
      console.error("Could not read the Claude profiles", error)
      set({ loading: false })
    }
  },

  create(name) {
    // No `configDir`: main fills one in and `save` takes its answer back.
    save(set, [
      ...get().profiles,
      { id: crypto.randomUUID(), name, configDir: "" },
    ])
  },

  rename(id, name) {
    save(
      set,
      get().profiles.map((profile) =>
        profile.id === id ? { ...profile, name } : profile
      )
    )
  },

  remove(id) {
    save(
      set,
      get().profiles.filter((profile) => profile.id !== id)
    )
  },
}))

/**
 * Written here and then to the record, rather than waiting on the write — the
 * same trade `setOptions` and `rename` make on `useWorktreeChats`: a field that
 * only moved once a file had been written would lag behind the keystroke that
 * changed it, and the failure it trades against does not outlive the launch.
 *
 * The exception is a profile with no directory yet, which is the one thing on
 * this list the renderer does not know: main names it and the answer is adopted
 * when it arrives. Only then, deliberately — a rename saves per keystroke, and
 * a reply to an earlier one landing late would type over what is on screen.
 */
function save(
  set: (partial: Partial<ClaudeProfilesState>) => void,
  profiles: ClaudeProfile[]
) {
  set({ profiles })

  const filling = profiles.some((profile) => !profile.configDir.trim())
  void window.desktop
    .saveClaudeProfiles(profiles)
    .then((stored) => {
      if (filling) set({ profiles: stored })
    })
    .catch((error: unknown) => {
      console.error("Could not save the Claude profiles", error)
    })
}

/**
 * What an account's state is called, and how loudly — the same four tones the
 * MCP section's `stateLabel` speaks in, so a badge means one thing across
 * Settings.
 *
 * `missing` is a directory that is not there, and it is deliberately not called
 * "signed out": the fix is a path, not a login, and the two were confusable
 * enough in an earlier draft that somebody would have run `claude login` at a
 * typo.
 */
export function accountLabel(account: ClaudeAccount | undefined): {
  label: string
  tone: "good" | "bad" | "waiting" | "off"
} {
  switch (account?.state) {
    case "signedIn":
      return { label: "Signed in", tone: "good" }
    case "signedOut":
      return { label: "Not signed in", tone: "bad" }
    case "missing":
      return { label: "No such directory", tone: "bad" }
    case "error":
      return { label: "Could not check", tone: "bad" }
    default:
      return { label: "Not checked", tone: "off" }
  }
}

/**
 * The line under a checked row: who it is signed in as and on what.
 *
 * Every field is optional because the CLI leaves out what does not apply — an
 * API-key login has no subscription, and an organisation is a team's — so this
 * joins whatever came back rather than laying out a fixed shape with gaps in
 * it. Empty for a directory that is not signed in, which the badge has already
 * said everything about.
 */
export function accountCaption(account: ClaudeAccount | undefined): string {
  if (!account || account.state !== "signedIn") return ""
  return [account.email, account.organization, account.plan, account.method]
    .filter(Boolean)
    .join(" · ")
}

/**
 * The one line the composer's picker has room for — **who**, not what state.
 *
 * A menu row is being chosen from rather than diagnosed: what somebody is
 * about to do is start a turn as one of these, so the answer that belongs
 * under the name is the address, and a badge saying `Signed in` beside an
 * email is the same fact twice. Everything that is *not* a working login falls
 * back to `accountLabel`'s own words, because those are the cases where the
 * state is the only thing worth the line.
 */
export function accountLine(account: ClaudeAccount | undefined): {
  text: string
  tone: "good" | "bad" | "waiting" | "off"
} {
  if (account?.state === "signedIn") {
    return {
      text: account.email ?? account.organization ?? "Signed in",
      tone: "good",
    }
  }
  const { label, tone } = accountLabel(account)
  return { text: label, tone }
}

/** A new profile's name, the same way `nextEnvironmentName` picks one. */
export function nextProfileName(count: number): string {
  return count === 0 ? "Profile" : `Profile ${count + 1}`
}
