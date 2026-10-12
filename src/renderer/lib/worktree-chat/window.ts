import type { AssistantMessage, ChatWindow, ChatWindowTone } from "@shared/api"

import { compact } from "./usage"

/**
 * How a chat's context window reads, with nothing behind it.
 *
 * Split from the drawing for the reason `usage.ts` is: what a meter says at 97%
 * and what it says when auto-compaction is off are decisions worth a test, and
 * they are arithmetic over two numbers.
 *
 * **The window is measured, not counted.** These figures come from the CLI's own
 * `getContextUsage()` (see `ChatWindow`), which is why there is a denominator at
 * all — a reply's usage carries what it was billed and not the size of the
 * window it was billed against.
 */

/**
 * How close the window is to being compacted, in three bands.
 *
 * Against the **auto-compact threshold** rather than against the window, which
 * is the whole point of reading it this way: on a 1M-window model the CLI
 * compacts at 967k, so 90% of the window is already past the line, while on a
 * model with no auto-compaction 99% is merely full. A meter that coloured on the
 * raw percentage would be crying wolf on one and silent on the other.
 *
 * Falls back to the raw percentage where there is no threshold — auto-compaction
 * switched off — because a window that is genuinely nearly full is still worth
 * saying, it just is not a warning about compaction.
 */
export type WindowBand = "calm" | "near" | "full"

export function bandOf(window: ChatWindow): WindowBand {
  const fraction = fractionOf(window)
  if (fraction >= 0.95) return "full"
  if (fraction >= 0.8) return "near"
  return "calm"
}

/**
 * How full the window is as a 0–1 fraction, against whichever limit is the one
 * that will actually act.
 *
 * Unclamped at the top on purpose: the SDK sends `totalTokens` unclamped, and a
 * window over its limit is the one case worth reporting honestly rather than
 * pinning to a full bar that looks like every other full bar. Callers that draw
 * a bar clamp it themselves; callers that pick a word do not want it clamped.
 */
export function fractionOf(window: ChatWindow): number {
  const limit = window.autoCompactAt || window.maxTokens
  if (limit <= 0) return 0
  return window.tokens / limit
}

/**
 * What is **left**, as a fraction: the complement of `fractionOf`, clamped.
 *
 * Clamped where `fractionOf` is not, and for the opposite reason. "Over the
 * limit" is a real state worth reporting honestly, but "minus eleven percent
 * left" is not a state — there is no such thing as less than nothing left. So a
 * window past its threshold reads as `0` here, which is the true answer to how
 * much room remains.
 */
export function remainingOf(window: ChatWindow): number {
  return Math.min(1, Math.max(0, 1 - fractionOf(window)))
}

/**
 * The meter's own label: `87% left`.
 *
 * **Counting down rather than up**, which is the reading the CLI's own
 * `Context left until auto-compact` gives and the one the number is actually
 * for. "13% used" is a fact about the past; the question somebody has while
 * typing is how much room is left before the conversation gets summarised, and a
 * meter should answer the question being asked rather than the one that is
 * easier to compute. The two are the same measurement — see `remainingOf`.
 *
 * The CLI's `percentage` is deliberately **not** used, even though it is right
 * there on the record. It is rounded against `rawMaxTokens`, while everything
 * here reads against the threshold that will actually fire — so drawing it
 * beside this file's bar would be a number and a bar disagreeing about one
 * window. The CLI's figure stays on the record for anything wanting the raw
 * reading.
 */
export function windowLabel(window: ChatWindow): string {
  return `${Math.round(remainingOf(window) * 100)}% left`
}

/**
 * The sentence under it — how much room is left, and until what.
 *
 * Names the threshold where there is one, because that is what is being counted
 * down to: "before auto-compacting" answers "how long have I got", where "of 1M"
 * answers a question nobody asked. Where auto-compaction is off there is nothing
 * to count down *to*, so the line says what is used instead — a countdown to an
 * event that will never happen would be a promise.
 */
export function windowDetail(window: ChatWindow): string {
  if (window.autoCompactAt) {
    const left = Math.max(0, window.autoCompactAt - window.tokens)
    return `${compact(left)} left before auto-compacting · ${compact(window.tokens)} of ${compact(window.autoCompactAt)} used`
  }
  return `${compact(window.tokens)} used of ${compact(window.maxTokens)} · auto-compact is off`
}

/**
 * The nudge under the meter once compaction is close, or null while it is not.
 *
 * Said at all because the meter alone reads as weather: a window at 85% looks
 * like something happening *to* the chat, when the cheapest move is the user's
 * own. Compaction is one summarisation call over everything in the window —
 * the most expensive single request a chat ever makes — and it buys a summary
 * where a new chat for a new task buys a clean window for nearly nothing. Only
 * where auto-compaction is actually armed: with it off, a filling window is
 * not counting down to anything this sentence describes.
 */
export function windowHint(window: ChatWindow): string | null {
  if (!window.autoCompactAt) return null
  if (bandOf(window) === "calm") return null
  return "Compacting summarises the whole conversation, which is a chat's most expensive single call — if the next thing is a new task, a new chat is cheaper."
}

/**
 * The rows of the breakdown, largest first, with the empty ones dropped.
 *
 * `Free space` is dropped rather than sorted with the rest: it is the remainder
 * and would be the largest row in almost every chat, which would make a list
 * meant to answer "what is filling this up" open with the thing that is not.
 * Deferred rows are **kept** — they are the tool schemas that are listed and not
 * charged, and "13.7k you are not paying for" belongs next to the ones you are —
 * but they are pushed below the rest, since they are not what is filling the
 * window either.
 */
export function windowSlices(window: ChatWindow): ChatWindow["slices"] {
  return window.slices
    .filter((slice) => slice.tokens > 0 && slice.tone !== "free")
    .sort((left, right) => {
      if (left.deferred !== right.deferred) return left.deferred ? 1 : -1
      return right.tokens - left.tokens
    })
}

/**
 * The colour a slice draws in.
 *
 * The app's own tokens, chosen here rather than taken from the CLI: its colours
 * are its terminal theme's names and mean nothing to a stylesheet — see
 * `ChatWindowTone`. `other` is deliberately the muted one, so a category a
 * future CLI invents draws as a neutral band instead of vanishing.
 */
export const WINDOW_TONES: Record<ChatWindowTone, string> = {
  system: "var(--section-files)",
  tools: "var(--chart-2)",
  memory: "var(--chart-3)",
  skills: "var(--chart-4)",
  messages: "var(--chart-5)",
  other: "var(--muted-foreground)",
  // Never drawn as a band — `windowSlices` drops it — but a total needs the
  // record to be complete or the map is a lie about which tones exist.
  free: "transparent",
}

/** The compaction line: what the window went from, and to. */
export function compactLine(
  line: Extract<AssistantMessage, { role: "compact" }>
): string {
  const how = line.trigger === "manual" ? "Compacted" : "Auto-compacted"
  // The post figure is optional on the wire — a CLI that reports only the one
  // side gets a line that says what it knows rather than `120k → undefined`.
  const sizes =
    line.postTokens === undefined
      ? `from ${compact(line.preTokens)}`
      : `${compact(line.preTokens)} → ${compact(line.postTokens)}`
  const took =
    line.durationMs === undefined
      ? ""
      : ` in ${(line.durationMs / 1000).toFixed(1)}s`
  return `${how} · ${sizes}${took}`
}
