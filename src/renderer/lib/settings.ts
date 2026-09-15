import { create } from "zustand"

import {
  CHAT_NOTIFICATIONS_KEY,
  CHAT_TRAY_KEY,
  MCP_DISABLED_TOOLS_KEY,
  type ChatEffort,
} from "@shared/api"
import { recall, remember } from "./tab-memory"
import { getSetting, setSetting } from "./workspace"

/** Where the studio's own preferences live, beside the strip's arrangement. */
const SETTINGS_KEY = "workbench.settings"

type Stored = {
  groupTabs: boolean
  /**
   * The diff view's two: the committed side beside the working one or the two
   * interleaved, and whether whitespace is drawn.
   *
   * Here rather than per file, because it is how somebody reads a diff rather
   * than something about a particular one — and here rather than in the Settings
   * dialog, because the control is the toolbar over the diff itself, where the
   * effect of the click is the thing being looked at.
   */
  diffSideBySide: boolean
  diffWhitespace: boolean
  /**
   * `--model`, `--effort` and the `CLAUDE_CONFIG_DIR` profile the read-only
   * one-turn agent runs on — `draftCommitMessage` and `distillLearnings` in
   * `main/one-turn-agent.ts`.
   *
   * A setting rather than a picker beside each button: unlike a chat, one of
   * these turns is not something anybody sits in front of for the length of a
   * conversation — it is a button pressed once in a while — so a picker beside
   * it is a control mostly seen once and then in the way. Chosen here instead
   * and left alone until it is changed again. Null on both is the same "leave
   * it alone" a chat's `Inherit` row means.
   *
   * Named `review*` because the agent review these were introduced for is what
   * first needed them, and the names are what is **already on disk** under
   * `workbench.settings`: renaming them would silently reset the choice for
   * everybody who had made one. See `docs/design.md` § Comments.
   */
  reviewModel: string | null
  reviewEffort: ChatEffort | null
  reviewProfileId: string | null
}

function isStored(value: unknown): value is Stored {
  // Every field is optional since `tabsPlacement` went, so this is the whole of
  // what tells a bag from a stored `null` — which would otherwise pass and be
  // spread over the defaults as though it had parsed. A leftover
  // `tabsPlacement` key is ignored rather than rejected: what is on disk is
  // left alone, and the next `save()` stops writing it.
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<Stored>
  return (
    // Absent from anything written before grouping existed, which is read as
    // off — the arrangement somebody already has is the one they chose. The two
    // diff flags are the same story, one feature later.
    (record.groupTabs === undefined || typeof record.groupTabs === "boolean") &&
    (record.diffSideBySide === undefined ||
      typeof record.diffSideBySide === "boolean") &&
    (record.diffWhitespace === undefined ||
      typeof record.diffWhitespace === "boolean") &&
    (record.reviewModel === undefined ||
      record.reviewModel === null ||
      typeof record.reviewModel === "string") &&
    (record.reviewEffort === undefined ||
      record.reviewEffort === null ||
      typeof record.reviewEffort === "string") &&
    (record.reviewProfileId === undefined ||
      record.reviewProfileId === null ||
      typeof record.reviewProfileId === "string")
  )
}

type SettingsState = Stored & {
  /** Read from disk yet. The dialog waits on it rather than showing the
   * default for a frame and correcting itself. */
  loaded: boolean

  /**
   * MCP tools a chat here may not call, as the wire names a turn's tool call
   * carries — see `MCP_DISABLED_TOOLS_KEY`.
   *
   * Not in `Stored` with the rest, and not in `workbench.settings`: the main
   * process reads this one too, on every message, to hand the CLI its
   * `disallowedTools`. So it lives under its own settings key, which is a thing
   * both sides can name, rather than inside a bag only the renderer parses.
   *
   * Empty by default, and empty is a decision the other way from the switches
   * that used to be here: what the user's own `claude` offers is theirs, and
   * this app hiding some of it until somebody found a dialog would be this app
   * deciding.
   */
  mcpDisabledTools: string[]

  /**
   * Whether a chat that finishes, fails or stops to ask rings an OS
   * notification while the window is unfocused.
   *
   * Outside `Stored` for the reason `mcpDisabledTools` is: the main process
   * reads it — it is what rings the bell — and a bag only the renderer parses
   * is not a thing both sides can name. **On by default**, which is the one
   * default in this file that goes the other way from the switches around it;
   * `CHAT_NOTIFICATIONS_KEY` says why.
   */
  chatNotifications: boolean

  /**
   * Whether the menu bar carries the standing count of what the chats are
   * doing.
   *
   * Beside `chatNotifications` in every way — main's to read, main's to act on,
   * and on by default for the same reason (`CHAT_TRAY_KEY`). The renderer keeps
   * it only so the switch can be drawn from the same store as its neighbour.
   */
  chatTray: boolean

  setGroupTabs: (group: boolean) => void
  setChatNotifications: (on: boolean) => void
  setChatTray: (on: boolean) => void
  setDiffSideBySide: (sideBySide: boolean) => void
  setDiffWhitespace: (show: boolean) => void
  /** Sets the model and its effort together, the way a chat's `ModelMenu`
   * hands them over. */
  setReviewModel: (model: string | null, effort: ChatEffort | null) => void
  setReviewProfileId: (profileId: string | null) => void
  /** Replaces the whole list — the pure `with*` helpers in
   * `lib/worktree-chat/mcp-servers.ts` work out what it should be. */
  setMcpDisabledTools: (tools: string[]) => void
  /** Reads the stored preferences. Called once, at launch. */
  restore: () => Promise<void>
}

/**
 * The switched-off tools as stored, or none.
 *
 * Anything that is not an array of strings reads as none rather than throwing —
 * the same call main makes on every message, and for the same reason: a setting
 * this app cannot parse must not take the user's MCP tools away, nor leave the
 * dialog unable to open.
 */
function storedTools(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : []
  } catch {
    return []
  }
}

/**
 * The preferences the Settings dialog edits.
 *
 * Separate from `lib/store.ts`, which holds what the workbench *is* doing —
 * the pane on screen, the folders, the strip's order. What is here is what the
 * user asked the studio to be like, which outlives any of that and is the list
 * the dialog is built from.
 */
export const useSettings = create<SettingsState>((set, get) => {
  /** Strict Mode mounts effects twice, so restoring has to be idempotent. */
  let restorePromise: Promise<void> | null = null

  /**
   * Writes the whole bag, from whatever the store now holds.
   *
   * One writer rather than each setter naming its neighbours: they share a key,
   * so a setter that listed two of the three fields would have written the
   * third back as absent — and absent reads as the default, which is a
   * preference silently undone by changing an unrelated one.
   */
  const save = () => {
    const {
      groupTabs,
      diffSideBySide,
      diffWhitespace,
      reviewModel,
      reviewEffort,
      reviewProfileId,
    } = get()
    remember(SETTINGS_KEY, {
      groupTabs,
      diffSideBySide,
      diffWhitespace,
      reviewModel,
      reviewEffort,
      reviewProfileId,
    })
  }

  return {
    groupTabs: false,
    // Side by side is what a diff is for — two columns to compare — and the
    // toolbar is one click away for a pane too narrow to hold them.
    diffSideBySide: true,
    diffWhitespace: false,
    reviewModel: null,
    reviewEffort: null,
    reviewProfileId: null,
    mcpDisabledTools: [],
    chatNotifications: true,
    chatTray: true,
    loaded: false,

    setGroupTabs(groupTabs) {
      set({ groupTabs })
      save()
    },

    setChatNotifications(chatNotifications) {
      set({ chatNotifications })
      // Its own key rather than `save()`'s bag, because main reads it. Written
      // as the two words main matches on, and only `"off"` means anything —
      // see `CHAT_NOTIFICATIONS_KEY`.
      void setSetting(CHAT_NOTIFICATIONS_KEY, chatNotifications ? "on" : "off")
    },

    setChatTray(chatTray) {
      set({ chatTray })
      // Its own key for the same reason as the switch above, and the write is
      // what puts the icon in the menu bar: main acts on this key as it lands
      // rather than at the next launch.
      void setSetting(CHAT_TRAY_KEY, chatTray ? "on" : "off")
    },

    setDiffSideBySide(diffSideBySide) {
      set({ diffSideBySide })
      save()
    },

    setDiffWhitespace(diffWhitespace) {
      set({ diffWhitespace })
      save()
    },

    setReviewModel(reviewModel, reviewEffort) {
      set({ reviewModel, reviewEffort })
      save()
    },

    setReviewProfileId(reviewProfileId) {
      set({ reviewProfileId })
      save()
    },

    setMcpDisabledTools(mcpDisabledTools) {
      set({ mcpDisabledTools })
      // Its own key rather than `save()`'s bag, because main reads it — and
      // written as it stands rather than merged, since the caller was handed the
      // whole list to work from.
      void setSetting(MCP_DISABLED_TOOLS_KEY, JSON.stringify(mcpDisabledTools))
    },

    restore() {
      restorePromise ??= (async () => {
        const [stored, disabled, notifications, tray] = await Promise.all([
          recall(SETTINGS_KEY, isStored),
          getSetting(MCP_DISABLED_TOOLS_KEY).catch(() => null),
          getSetting(CHAT_NOTIFICATIONS_KEY).catch(() => null),
          getSetting(CHAT_TRAY_KEY).catch(() => null),
        ])
        set({
          // Nothing stored is the default, not a failure: the spread of a null
          // leaves the initial state as it stands.
          ...stored,
          mcpDisabledTools: storedTools(disabled),
          // Only `"off"` switches it off, so an unreadable or absent key is on
          // — the same reading main does, and the two must agree or the switch
          // would show one thing while the bell did another.
          chatNotifications: notifications !== "off",
          // The same reading, for the same reason: main puts the icon in the
          // strip unless the key says `off`, and a switch drawn the other way
          // would describe a menu bar the user is looking at.
          chatTray: tray !== "off",
          loaded: true,
        })
      })()
      return restorePromise
    },
  }
})
