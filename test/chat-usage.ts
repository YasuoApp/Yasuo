import type { AssistantMessage, TurnUsage } from "../src/shared/api"
import { contextOf, usageOf } from "../src/main/claude-agent"
import {
  chatLine,
  compact,
  modelLabel,
  money,
  promptOf,
  totalOf,
  usageDetail,
  usageLine,
} from "../src/renderer/lib/worktree-chat/usage"
import { check, finish, section } from "./harness"

/**
 * What a turn cost: the read of it, and the words for it.
 *
 * Worth a test for the reason `chat-activity.ts` is: both halves read something
 * this app does not own. `usageOf` reads the SDK's result line, which reports
 * per-model totals that have to be summed rather than picked from — a turn that
 * ran a subagent spent what the subagent spent — and reports zeroes for a turn
 * that crashed, which must not be drawn as a turn that was free. The renderer's
 * half is a percentage over three numbers, and the case that matters is the one
 * the whole feature exists for: a prompt that was written to the cache rather
 * than read from it.
 *
 * `SDKMessage`'s result type is deliberately not imported: these are the fields
 * this app reads, and a fixture built out of the SDK's own type would be a test
 * that only checks the parts of it we already believed.
 */

type Result = Parameters<typeof usageOf>[0]

const result = (
  models: Record<
    string,
    {
      inputTokens?: number
      cacheCreationInputTokens?: number
      cacheReadInputTokens?: number
      outputTokens?: number
    }
  >,
  extra: { cost?: number; thinking?: number } = {}
): Result =>
  ({
    type: "result",
    subtype: "success",
    total_cost_usd: extra.cost ?? 0,
    usage: {
      output_tokens_details: { thinking_tokens: extra.thinking ?? 0 },
    },
    modelUsage: Object.fromEntries(
      Object.entries(models).map(([name, use]) => [
        name,
        {
          inputTokens: use.inputTokens ?? 0,
          outputTokens: use.outputTokens ?? 0,
          cacheReadInputTokens: use.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: use.cacheCreationInputTokens ?? 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      ])
    ),
  }) as unknown as Result

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  model: "claude-opus-5",
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  thinking: 0,
  costUsd: null,
  context: null,
  durationMs: null,
  ...over,
})

let next = 0
const line = (over: Partial<TurnUsage>): AssistantMessage => ({
  id: `l${(next += 1)}`,
  role: "usage",
  usage: usage(over),
})

section("usageOf: the SDK's result line")
{
  const one = usageOf(
    result(
      {
        "claude-opus-5": {
          inputTokens: 10,
          cacheCreationInputTokens: 1_563,
          cacheReadInputTokens: 37_575,
          outputTokens: 1_904,
        },
      },
      { cost: 0.3103, thinking: 462 }
    )
  )
  check("names the model it ran on", one.model === "claude-opus-5", one)
  check("keeps the cache halves apart", one.cacheWrite === 1_563, one)
  check("reads the cache hit", one.cacheRead === 37_575, one)
  check("takes thinking off `usage`", one.thinking === 462, one)
  check("keeps the estimate", one.costUsd === 0.3103, one)

  // A turn that ran a subagent: the SDK's own `usage` would report the main
  // loop alone, which is the whole reason `modelUsage` is what is read.
  const withAgent = usageOf(
    result({
      "claude-opus-5": { inputTokens: 5, outputTokens: 900 },
      "claude-haiku-4-5-20251001": {
        cacheReadInputTokens: 12_000,
        outputTokens: 100,
      },
    })
  )
  check(
    "sums every model the turn used",
    withAgent.output === 1_000 && withAgent.cacheRead === 12_000,
    withAgent
  )
  check(
    "labels it with the busiest, not the last",
    withAgent.model === "claude-haiku-4-5-20251001",
    withAgent
  )

  const crashed = usageOf(result({}))
  check("a turn that counted nothing has no model", crashed.model === null)
  check(
    "and no cost, rather than a free one",
    crashed.costUsd === null,
    crashed
  )
  check(
    "which the line says out loud",
    usageLine(crashed) === "nothing counted",
    usageLine(crashed)
  )
}

/**
 * The half that streaming input added.
 *
 * A session answers many turns from one process, and the SDK's `modelUsage` and
 * `total_cost_usd` are the session's running total on every result line. Read
 * raw, the second turn of a chat is drawn as having cost what the first one cost
 * as well — which is exactly the number somebody is looking at the line to find
 * out. So the previous result goes in and the difference comes out.
 */
section("usageOf: one turn out of a session's running total")
{
  const first = result(
    {
      "claude-opus-5": {
        inputTokens: 10,
        cacheCreationInputTokens: 1_500,
        cacheReadInputTokens: 30_000,
        outputTokens: 900,
      },
    },
    { cost: 0.2, thinking: 100 }
  )
  // The same line a turn later: everything above, plus what this turn added.
  const second = result(
    {
      "claude-opus-5": {
        inputTokens: 14,
        cacheCreationInputTokens: 1_700,
        cacheReadInputTokens: 68_000,
        outputTokens: 1_400,
      },
    },
    { cost: 0.35, thinking: 250 }
  )

  const turn = usageOf(second, first)
  check(
    "counts what this turn added, not the session",
    turn.input === 4 &&
      turn.cacheWrite === 200 &&
      turn.cacheRead === 38_000 &&
      turn.output === 500,
    turn
  )
  check("and the cost with it", closeTo(turn.costUsd, 0.15), turn.costUsd)
  // Per-turn on the SDK's own account, so it is the one number not subtracted —
  // taking 250 − 100 here would report a turn that reasoned less than it did.
  check(
    "leaves thinking alone, which is already per turn",
    turn.thinking === 250,
    turn
  )

  // No previous line at all is the first turn of a process, which is the whole
  // of what it spent — and the shape every existing caller of one argument has.
  const opening = usageOf(first)
  check(
    "the first turn of a session is read whole",
    opening.input === 10 && opening.output === 900,
    opening
  )

  /*
   * A model that did nothing this turn is still on the line.
   *
   * The SDK carries every model the session has ever used, at last turn's
   * numbers, so a chat that ran a Haiku subagent once has a Haiku entry for ever
   * — and it subtracts to zero. The label has to name the one that actually
   * worked, or every later turn of that chat is attributed to a subagent that
   * ran twenty minutes ago.
   */
  const laterTurn = usageOf(
    result({
      "claude-opus-5": { inputTokens: 20, cacheReadInputTokens: 50_000 },
      "claude-haiku-4-5-20251001": { cacheReadInputTokens: 90_000 },
    }),
    result({
      "claude-opus-5": { inputTokens: 10, cacheReadInputTokens: 10_000 },
      "claude-haiku-4-5-20251001": { cacheReadInputTokens: 90_000 },
    })
  )
  check(
    "a model that sat this turn out counts for nothing",
    laterTurn.cacheRead === 40_000,
    laterTurn
  )
  check(
    "and cannot take the label off the one that worked",
    laterTurn.model === "claude-opus-5",
    laterTurn
  )

  /*
   * A total that went backwards is a reset, not a refund.
   *
   * A mid-session `/clear` starts the running totals over, and so does a session
   * opened again over the same id. The only reading of the new line that is not
   * negative is the line itself.
   */
  const afterClear = usageOf(
    result(
      { "claude-opus-5": { inputTokens: 3, outputTokens: 40 } },
      { cost: 0.01 }
    ),
    second
  )
  check(
    "a reset is read as the line standing on its own",
    afterClear.input === 3 && afterClear.output === 40,
    afterClear
  )
  check(
    "including its cost, rather than a negative one",
    closeTo(afterClear.costUsd, 0.01),
    afterClear.costUsd
  )
}

/** Floating-point subtraction of two decimals does not land on the decimal —
 * `0.35 - 0.2` is `0.15000000000000002` — and the difference is money nobody
 * can see. */
function closeTo(value: number | null, expected: number): boolean {
  return value !== null && Math.abs(value - expected) < 1e-9
}

/**
 * Where the conversation stands, which is not one of the spends.
 *
 * The trap this guards is the one that makes the number meaningless: every
 * other figure on the line is a sum — over the turn's model calls, its
 * subagents, and then over the chat's turns — and a context read the same way
 * grows without limit, so a chat of ten 40k turns would claim 400k of a window
 * it never filled. It is a level: the last reply's own prompt and answer, and
 * the last turn's rather than every turn's.
 */
section("the context window")
{
  check(
    "a reply's own numbers are the window it sat in",
    contextOf({
      input_tokens: 12,
      cache_creation_input_tokens: 1_500,
      cache_read_input_tokens: 46_000,
      output_tokens: 800,
    }) === 48_312
  )
  check("a reply that counted nothing reports none", contextOf({}) === null)
  check("and neither does a missing one", contextOf(undefined) === null)

  const turn = usageOf(
    result({ "claude-opus-5": { inputTokens: 10, outputTokens: 900 } }),
    null,
    48_312
  )
  check("the result line carries it", turn.context === 48_312, turn)
  check(
    "a turn that never got a reply has none",
    usageOf(result({})).context === null
  )

  check(
    "the line names it",
    usageLine(usage({ context: 48_312 })).includes("48.3k context"),
    usageLine(usage({ context: 48_312 }))
  )
  check(
    "and a chat from before the field says nothing rather than `undefined`",
    !usageLine(usage({ context: null })).includes("context")
  )

  // The whole point: two turns of 40k each are a 40k conversation.
  const total = totalOf([line({ context: 39_000 }), line({ context: 41_000 })])
  check("a chat stands where its last turn left it", total?.context === 41_000)
  check(
    "and a turn that reported none does not empty it",
    totalOf([line({ context: 41_000 }), line({ context: null })])?.context ===
      41_000
  )

  /*
   * The line under the composer, where the live figure meets the record.
   *
   * The case worth the test is the first turn of a chat: there are no usage
   * lines yet — they are written when a turn *ends* — so a line built from the
   * total alone says nothing for the whole of the first answer, which is the
   * one somebody is watching this number for.
   */
  check(
    "a live figure beats the last turn's",
    chatLine(total, 52_000)?.includes("52.0k context") === true,
    chatLine(total, 52_000)
  )
  check(
    "and the last turn's stands in when there is none",
    chatLine(total)?.includes("41.0k context") === true
  )
  check(
    "a first turn still running is the context alone",
    chatLine(null, 12_800) === "12.8k context"
  )
  check("and a chat with nothing at all says nothing", chatLine(null) === null)
  check(
    "as does one whose turns are all older than the field",
    chatLine(totalOf([line({ context: null })])) !== null &&
      !chatLine(totalOf([line({ context: null })]))?.includes("context")
  )
}

section("the line somebody reads")
{
  const cold = usage({
    input: 10,
    cacheWrite: 38_782,
    cacheRead: 0,
    output: 46,
    costUsd: 0.0788,
  })
  const warm = usage({
    input: 10,
    cacheWrite: 0,
    cacheRead: 38_797,
    output: 108,
    costUsd: 0.0054,
  })

  check("the same prompt either way", promptOf(cold) === 38_792, promptOf(cold))
  check(
    "a cold turn says so",
    usageLine(cold).includes("0% cached"),
    usageLine(cold)
  )
  check(
    "a warm one says so",
    usageLine(warm).includes("100% cached"),
    usageLine(warm)
  )
  // The estimate is the breakdown's, not the line's — the line is token counts.
  check(
    "the line carries no money",
    !usageLine(warm).includes("$") && !usageLine(cold).includes("$"),
    [usageLine(cold), usageLine(warm)]
  )
  check(
    "and the estimate keeps its digits under a cent",
    usageDetail(warm).includes("$0.0054") &&
      usageDetail(cold).includes("$0.08"),
    [usageDetail(cold), usageDetail(warm)]
  )
  check(
    "the breakdown splits the prompt three ways",
    usageDetail(cold).startsWith("38,792 prompt = 10 new + 38,782 written"),
    usageDetail(cold)
  )
  check(
    "thinking is on the line where there was any",
    usageLine(usage({ output: 100, thinking: 40 })).includes(
      "100 out (40 thinking)"
    ) &&
      usageDetail(usage({ output: 100, thinking: 40 })).includes(
        "40 of it thinking"
      ),
    usageLine(usage({ output: 100, thinking: 40 }))
  )
  check(
    "and off it where there was none",
    !usageLine(usage({ output: 100, thinking: 0 })).includes("thinking"),
    usageLine(usage({ output: 100, thinking: 0 }))
  )
}

/**
 * How long the turn took, which is the one figure on the line that is not read
 * off the result at all.
 *
 * The SDK's own `duration_ms` is the session's, like every other number there,
 * so it is measured around the turn in `claude-agent.ts` and handed in. What is
 * worth guarding is the pair of ends: a line from before the field says nothing
 * rather than `0s`, and a chat's turns add up where its context does not.
 */
section("what a turn took")
{
  const turn = usageOf(
    result({ "claude-opus-5": { inputTokens: 10, outputTokens: 900 } }),
    null,
    null,
    65_400
  )
  check("the caller's measurement is carried", turn.durationMs === 65_400, turn)
  check(
    "a turn nobody timed reports none",
    usageOf(result({})).durationMs === null
  )

  check(
    "the line says it in the spinner's words",
    usageLine(usage({ durationMs: 65_400 })).includes("1m5s"),
    usageLine(usage({ durationMs: 65_400 }))
  )
  const untimed = usage({ output: 900, durationMs: null })
  check(
    "and a chat from before the field says nothing",
    !/\d+s/.test(usageLine(untimed)),
    usageLine(untimed)
  )

  const total = totalOf([line({ durationMs: 20_000 }), line({ durationMs: 5 })])
  check("a chat's turns add up", total?.durationMs === 20_005, total)
  check(
    "and an untimed one is skipped rather than zeroing them",
    totalOf([line({ durationMs: null }), line({ durationMs: 3_000 })])
      ?.durationMs === 3_000
  )
  check(
    "a chat where none of them were timed has no time",
    totalOf([line({ durationMs: null })])?.durationMs === null
  )
}

section("a chat's total")
{
  check("nothing to total is null", totalOf([]) === null)
  check(
    "and so is a chat written before there were usage lines",
    totalOf([{ id: "l0", role: "assistant", text: "done" }]) === null
  )

  const total = totalOf([
    { id: "u", role: "user", text: "hello" },
    line({ cacheWrite: 40_000, output: 100, costUsd: 0.5 }),
    line({ cacheRead: 40_000, output: 200, costUsd: 0.05 }),
  ])
  check("counts the turns", total?.turns === 2, total)
  check("adds the halves up", total?.cacheWrite === 40_000, total)
  check("adds the cost up", total?.costUsd === 0.55, total)
  check(
    "and keeps the model while they agree",
    total?.model === "claude-opus-5",
    total
  )

  const mixed = totalOf([
    line({ model: "claude-opus-5" }),
    line({ model: "claude-haiku-4-5-20251001" }),
  ])
  check(
    "a chat that changed model claims neither",
    mixed?.model === null,
    mixed
  )

  // A turn that crashed reported no cost; the ones around it still did.
  const partial = totalOf([line({ costUsd: null }), line({ costUsd: 0.2 })])
  check("an uncounted turn is skipped, not zeroed", partial?.costUsd === 0.2)
  check(
    "and a chat where none of them counted has no cost",
    totalOf([line({ costUsd: null })])?.costUsd === null
  )
}

section("the model's name, and the numbers")
{
  check("Opus 5", modelLabel("claude-opus-5") === "Opus 5")
  check(
    "a dated id is the same model",
    modelLabel("claude-haiku-4-5-20251001") === "Haiku 4.5"
  )
  check(
    "so is a provider-qualified one",
    modelLabel("us.anthropic.claude-opus-4-1-20250805-v1:0") === "Opus 4.1"
  )
  check("an alias is drawn as it stands", modelLabel("opus") === "Opus")
  check("and nothing is nothing", modelLabel(null) === null)

  check("under a thousand is itself", compact(946) === "946")
  check("a thousand gets a digit", compact(38_797) === "38.8k")
  check("and loses it once it says nothing", compact(410_400) === "410k")
  check("millions too", compact(4_180_000) === "4.2M")
  check("a cent is two places", money(0.31) === "$0.31")
  check("under one is four", money(0.0049) === "$0.0049")
}

finish()
