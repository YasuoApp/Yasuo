import { create } from "zustand"

import {
  DEFAULT_CHAT_OPTIONS,
  type ChatOptions,
  type ClaudeAccount,
  type ClaudeProfile,
} from "@shared/api"
import { FREE_PROFILE_ID, forFreeAi } from "@shared/free-ai"

/**
 * Whether the free AI can be offered in this window — see `shared/free-ai.ts`.
 *
 * `ready` follows the studio's own sign-in: `watchAccount` hands main every
 * token Firebase refreshes and lands main's answer here, so the composer's
 * menu shows the free AI exactly while main can run it.
 */
type FreeAiState = {
  /** This build has a server for it at all. Asked once. */
  available: boolean
  /** Somebody is signed in and main holds their token. */
  ready: boolean
}

export const useFreeAi = create<FreeAiState>()(() => ({
  available: false,
  ready: false,
}))

let asked = false

/** Asks main once whether there is a server. Idempotent. */
export function watchFreeAi(): void {
  if (asked) return
  asked = true
  void window.desktop
    .freeAiAvailable()
    .then((available) => useFreeAi.setState({ available }))
    .catch((error: unknown) => {
      console.error("Could not ask whether the free AI is available", error)
    })
}

/** Hands main the signed-in user's token, or null — from `watchAccount`. */
export async function handFreeAiToken(token: string | null): Promise<void> {
  try {
    const ready = await window.desktop.setFreeAiToken(token)
    useFreeAi.setState({ ready })
  } catch (error) {
    console.error("Could not hand the free AI its token", error)
    useFreeAi.setState({ ready: false })
  }
}

/**
 * What a new chat opens on: the free AI for somebody with no Claude login of
 * their own, everything else as it always was.
 *
 * **Only when the default login is known to be signed out**, and nobody has a
 * profile: somebody who has run `claude auth login` is spending their own plan
 * on purpose, and a chat that quietly moved them onto Haiku would be a worse
 * answer than the one they already had. An unchecked login (`undefined`) is
 * not "signed out" — the setup screen asks at launch, so this is the moment
 * before it answers.
 */
export function newChatOptions(input: {
  ready: boolean
  login: ClaudeAccount | undefined
  profiles: ClaudeProfile[]
}): ChatOptions | undefined {
  const signedOut =
    input.login !== undefined && input.login.state !== "signedIn"
  if (!input.ready || !signedOut || input.profiles.length > 0) return undefined
  return forFreeAi({ ...DEFAULT_CHAT_OPTIONS, profileId: FREE_PROFILE_ID })
}
