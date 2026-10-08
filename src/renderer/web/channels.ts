import { IPC } from "@shared/api"

/**
 * The tab's `window.desktop`, generated from the `IPC` map.
 *
 * Generated rather than written out a method at a time because the preload's
 * own rule is that a method is named for its channel — `gitStatus(…)` is
 * `invoke(IPC.gitStatus, …)`, and `onTreeChanged` subscribes to
 * `IPC.treeChanged` — so a fifth hand-written copy of the contract would be one
 * more place for a new call to be forgotten in. `test/web-desktop.ts` holds the
 * result to every key the preload exposes.
 *
 * Free of the DOM, so that test can import it.
 */

/** The channels main pushes on, as opposed to the ones the renderer calls —
 * each is exposed as `on` + the key. */
export const PUSHED = [
  "menuCommand",
  "directoryChanged",
  "treeChanged",
  "snapshotsChanged",
  "worktreeChatEvent",
  "revealWorktreeChat",
  "terminalData",
  "terminalExit",
  "updateProgress",
  "workflowRunEvent",
] as const satisfies readonly (keyof typeof IPC)[]

/** What the preload exposes that is not a channel at all — answered by the
 * tab itself (`desktop.ts`), as the preload answers them itself. */
export const LOCAL_ONLY = [
  "platform",
  "runtime",
  "resolveNoteFileUrl",
  "getPathForFile",
] as const

export function channelMethods(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  subscribe: (channel: string, listener: (payload: never) => void) => () => void
): Record<string, unknown> {
  const methods: Record<string, unknown> = {}
  const pushed = new Set<string>(PUSHED)
  for (const [key, channel] of Object.entries(IPC)) {
    if (pushed.has(key)) {
      const name = `on${key.charAt(0).toUpperCase()}${key.slice(1)}`
      methods[name] = (listener: (payload: never) => void) =>
        subscribe(channel, listener)
    } else {
      methods[key] = (...args: unknown[]) => invoke(channel, ...args)
    }
  }
  return methods
}
