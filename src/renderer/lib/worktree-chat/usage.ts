import type { AssistantMessage, TurnUsage } from "@shared/api"
import { duration } from "./since"

/**
 * What a turn cost, in words.
 *
 * **Why this is drawn at all.** The numbers were read and dropped: the SDK
 * reports them once, on the result line, and nothing in the app kept them — so
 * the one question a chat cannot otherwise answer is why an afternoon of turns
 * came to what it came to. What actually decides that is not the size of the
 * prompt, which barely changes, but which side of the cache it landed on: a
 * prompt read back is billed at a tenth, and one written is billed at a quarter
 * more than full price. A turn showing `39.1k prompt, 0% cached` is this app
 * having asked for a prefix nothing had cached yet — a system prompt or a tool
 * list no other turn shares, or an hour since the last turn that shared one —
 * and that is worth twelve times the same turn a minute later. So the cached
 * share is on the line rather than in the breakdown behind it.
 *
 * The model is on it for the other half of the same question: the toolbar's
 * `null` leaves the user's own `claude` deciding, and what it decides is
 * whatever their global settings say — so a chat can be running on Opus for
 * days without anything on screen having said so.
 *
 * Pure, and tested in `test/chat-usage.ts`: the cases are the shapes a result
 * line comes in — a turn with no cache at all, a chat that changed model
 * halfway, a crashed turn that reported nothing — rather than anything about
 * how the row looks.
 */

/** A chat's turns added up. `model` is null where they did not all agree, which
 * is the honest answer for a chat whose toolbar was changed halfway. */
export type ChatTotal = TurnUsage & { turns: number }

/** Everything the turn was sent, however it was billed. */
export function promptOf(usage: TurnUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead
}

/**
 * One line: the model, what was sent, how much of it was cached, what came
 * back, and the estimate.
 *
 * The cached share is a percentage rather than the two token counts, because
 * the counts are read as one fact — "did this turn pay for its prompt" — and
 * the counts themselves are a hover away for the times the answer is no.
 */
export function usageLine(usage: TurnUsage | ChatTotal): string {
  const parts: string[] = []

  if ("turns" in usage) parts.push(plural(usage.turns, "turn"))
  const model = modelLabel(usage.model)
  if (model) parts.push(model)

  const prompt = promptOf(usage)
  if (prompt > 0) {
    const cached = Math.round((usage.cacheRead / prompt) * 100)
    parts.push(`${compact(prompt)} prompt, ${cached}% cached`)
  }
  if (usage.output > 0) {
    // The thinking share beside the output rather than only in the breakdown:
    // it is the one figure the effort picker moves, and output is billed the
    // same whether it is read or reasoned — a turn whose output was mostly
    // thinking is the fact somebody deciding to turn effort down needs on the
    // row, not a hover away.
    parts.push(
      usage.thinking > 0
        ? `${compact(usage.output)} out (${compact(usage.thinking)} thinking)`
        : `${compact(usage.output)} out`
    )
  }
  // What it took on the clock, in the spinner's own words: the figure that was
  // on screen while the turn ran is the one worth keeping once it has stopped
  // moving, and a chat's total is the afternoon added up. Truthy rather than
  // `!== null` for the reason `context` is — a line written before the field
  // existed has none, and a chat from last week saying `0s` would be this app
  // claiming its turns were instant.
  if (usage.durationMs) parts.push(duration(usage.durationMs))
  // Where the chat stands rather than what it spent, and the reason it is last:
  // the figures before it are sums that only grow, and this one is a level —
  // it falls when the conversation is compacted. Truthy rather than `!== null`
  // because a line written before the field existed has no `context` at all,
  // and `undefined context` on the row of a chat from last week is worse than
  // the chat not saying.
  if (usage.context) parts.push(`${compact(usage.context)} context`)
  // The estimate is not on the line, only in `usageDetail` behind the hover: a
  // running dollar figure under the composer is read every time it changes and
  // says nothing that can be acted on mid-chat, where the token counts beside
  // it do. It is still counted and still one hover away.

  // A result that reported nothing at all — a crashed turn carries zeroes —
  // rather than a row saying the turn was free.
  return parts.join(" · ") || "nothing counted"
}

/**
 * The line under the composer: the chat's own totals, with the context figure
 * as of the last reply rather than the last turn.
 *
 * The two come from different places and only this line joins them. The totals
 * are summed from the usage lines, which land once a turn ends; `context` is
 * the live figure main sends per reply, and it is what somebody watching a long
 * turn is watching. Where there is no live one — a reloaded window, a chat
 * nothing has run this session — the last turn's own stands in, which is the
 * same quantity one answer stale rather than a different number.
 *
 * Null when there is nothing to say at all. A chat whose first turn is still
 * running has no usage lines yet but does have a context, and that alone is the
 * line: a chat that says nothing until its first turn ends is the case this
 * whole figure exists for.
 */
export function chatLine(
  total: ChatTotal | null,
  context?: number | null
): string | null {
  const live = context ?? total?.context ?? null
  if (!total) return live ? `${compact(live)} context` : null
  return usageLine({ ...total, context: live })
}

/**
 * The same numbers in full, for the hover line.
 *
 * Where the percentage on the row is read, this is what it is checked against,
 * so it is the three prompt figures apart rather than added up. The thinking
 * share is here in full, beside the compact copy on the row itself.
 */
export function usageDetail(usage: TurnUsage | ChatTotal): string {
  const lines = [
    `${count(promptOf(usage))} prompt = ${count(usage.input)} new + ${count(
      usage.cacheWrite
    )} written to cache + ${count(usage.cacheRead)} read from cache`,
    `${count(usage.output)} output${
      usage.thinking > 0 ? `, ${count(usage.thinking)} of it thinking` : ""
    }`,
  ]
  if (usage.context) {
    lines.push(`${count(usage.context)} in the window when the turn ended`)
  }
  if (usage.model) lines.push(usage.model)
  if (usage.costUsd !== null) {
    lines.push(`${money(usage.costUsd)} — the CLI's own estimate`)
  }
  return lines.join("\n")
}

/**
 * A chat's own total, out of the usage lines in it.
 *
 * Summed here rather than kept on the record for the reason the lines are
 * lines: a chat read back off disk is the only account of what it cost, and a
 * running total on the record would be a second one to keep in step. Null for a
 * chat with no usage lines at all — every chat written before they existed —
 * which is what stops an empty total being drawn as a free one.
 */
export function totalOf(lines: AssistantMessage[]): ChatTotal | null {
  const uses = lines.flatMap((line) =>
    line.role === "usage" ? [line.usage] : []
  )
  if (uses.length === 0) return null

  const models = new Set(uses.map((use) => use.model).filter(Boolean))

  return uses.reduce<ChatTotal>(
    (sum, use) => ({
      turns: sum.turns + 1,
      // One model or none: a total labelled with the last turn's model would be
      // a chat that ran half on Haiku claiming to have run on Opus.
      model: models.size === 1 ? [...models][0]! : null,
      input: sum.input + use.input,
      cacheWrite: sum.cacheWrite + use.cacheWrite,
      cacheRead: sum.cacheRead + use.cacheRead,
      output: sum.output + use.output,
      thinking: sum.thinking + use.thinking,
      // Null only when no turn reported one; a chat where one turn crashed
      // still cost what the others cost.
      costUsd:
        use.costUsd === null ? sum.costUsd : (sum.costUsd ?? 0) + use.costUsd,
      // The last one that reported, never a sum: this is where the conversation
      // stands, and adding the turns up would say a chat of ten 40k turns is
      // 400k of context — four times a window it never came close to filling.
      // Turns that reported nothing are skipped rather than resetting it, since
      // a crash does not empty the conversation behind it.
      context: use.context ?? sum.context,
      // Summed like the spends and unlike `context`: a chat's time is every
      // turn's time, and the turns of one chat never overlap. Null only where
      // no turn reported one, so a chat with older lines in it totals the ones
      // that were measured rather than reading as faster than it was.
      durationMs:
        use.durationMs === null
          ? sum.durationMs
          : (sum.durationMs ?? 0) + use.durationMs,
    }),
    {
      turns: 0,
      model: null,
      input: 0,
      cacheWrite: 0,
      cacheRead: 0,
      output: 0,
      thinking: 0,
      costUsd: null,
      context: null,
      durationMs: null,
    }
  )
}

/**
 * `claude-haiku-4-5-20251001` as `Haiku 4.5`.
 *
 * Derived rather than looked up in a table: the id comes from the CLI, which
 * grows a new one every few months, and a table would draw the raw id for
 * exactly the model somebody has just switched to. The date suffix goes because
 * two ids for one model are one model, and the dots come back because `4-5` is
 * a version somebody reads as 4.5.
 */
export function modelLabel(model: string | null): string | null {
  if (!model) return null

  // A provider-qualified id — `us.anthropic.claude-opus-4-1-20250805-v1:0` — is
  // the same model with a routing prefix in front of it, so the label starts
  // wherever `claude-` does.
  const at = model.indexOf("claude-")
  const name = (at === -1 ? model : model.slice(at + "claude-".length)).replace(
    /-\d{8}(-v\d+:\d+)?$/,
    ""
  )
  if (!name) return null

  const [family, ...version] = name.split("-")
  if (!family) return null
  const labelled = family.charAt(0).toUpperCase() + family.slice(1)
  return version.length > 0 ? `${labelled} ${version.join(".")}` : labelled
}

/** `41.2k`, because the row is scanned rather than added up. */
export function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${round(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${round(tokens / 1_000)}k`
  return `${tokens}`
}

function round(value: number): string {
  // One decimal until it stops saying anything: `1.2k` is worth a digit and
  // `41.2k` is not far off noise, but `410k` never needs one.
  return value >= 100 ? `${Math.round(value)}` : value.toFixed(1)
}

function count(tokens: number): string {
  return tokens.toLocaleString()
}

/**
 * The estimate, to as many digits as it has.
 *
 * Four decimals under a cent, because a turn on Haiku that read its whole
 * prompt from the cache costs $0.005, and `$0.01` for all of them would make
 * the cheap turns and the twelve-times-dearer ones look like the same turn.
 */
export function money(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

function plural(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`
}
