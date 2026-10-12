import { readWindow } from "../src/main/claude-agent"
import {
  bandOf,
  compactLine,
  fractionOf,
  remainingOf,
  windowDetail,
  windowHint,
  windowLabel,
  windowSlices,
  WINDOW_TONES,
} from "../src/renderer/lib/worktree-chat/window"
import { check, finish, section } from "./harness"
import type { ChatWindow } from "../src/shared/api"

/**
 * How full a context window reads, and what the CLI's report is narrowed to.
 *
 * The thing worth testing here is the denominator. A meter measured against the
 * raw window sits calm on a 1M-context model right up to the moment the CLI
 * compacts at 967k — the warning arrives after the conversation has already been
 * summarised out from under it. Everything below is about getting that one
 * choice right, and about a CLI release moving a field under us.
 */

const window = (over: Partial<ChatWindow> = {}): ChatWindow => ({
  tokens: 20_000,
  maxTokens: 1_000_000,
  percentage: 2,
  autoCompactAt: 967_000,
  model: "claude-fable-5",
  slices: [],
  ...over,
})

section("the window is read against what will actually fire")

check(
  "the threshold, not the window",
  // 900k of a 1M window is 90% of the window and 93% of the threshold.
  Math.round(fractionOf(window({ tokens: 900_000 })) * 100) === 93
)
check(
  "the window when there is no threshold",
  Math.round(
    fractionOf(window({ tokens: 900_000, autoCompactAt: null })) * 100
  ) === 90
)

// The one case worth reporting honestly rather than pinning to a full bar: the
// SDK sends `totalTokens` unclamped, and over-limit is a real state.
check("over the limit is over 1", fractionOf(window({ tokens: 1_100_000 })) > 1)

// A window with no denominator at all — a CLI that reported neither. Zero
// rather than Infinity or NaN, both of which draw as a bar of nonsense.
check(
  "no denominator is not a division",
  fractionOf(window({ maxTokens: 0, autoCompactAt: null })) === 0
)

section("the bands warn about compaction, not about fullness")

check("calm well below", bandOf(window({ tokens: 20_000 })) === "calm")
check("calm just under", bandOf(window({ tokens: 700_000 })) === "calm")
check(
  "near at 80% of the threshold",
  bandOf(window({ tokens: 780_000 })) === "near"
)
check("full at 95%", bandOf(window({ tokens: 930_000 })) === "full")
check("full when over", bandOf(window({ tokens: 1_100_000 })) === "full")

// The same token count reads differently with and without a threshold, which is
// the whole point of the band: 930k is 96% of the 967k the CLI will act on, and
// only 93% of a window that nothing is going to act on at all.
check(
  "no threshold falls back to the window",
  bandOf(window({ tokens: 930_000, autoCompactAt: null })) === "near" &&
    bandOf(window({ tokens: 930_000 })) === "full"
)

section("the nudge arrives with the warning, and only where compaction will")

check("quiet while calm", windowHint(window({ tokens: 20_000 })) === null)
check(
  "speaks once the band does",
  windowHint(window({ tokens: 780_000 })) !== null &&
    windowHint(window({ tokens: 930_000 })) !== null
)
// A window filling with auto-compaction off is not counting down to the event
// the sentence describes, however full it is.
check(
  "quiet with auto-compaction off",
  windowHint(window({ tokens: 930_000, autoCompactAt: null })) === null
)

section("the meter counts down, not up")

// The reading the CLI's own `Context left until auto-compact` gives, and the
// question somebody actually has while typing.
check("the label is what is left", windowLabel(window()) === "98% left")
check(
  "the label follows the threshold",
  windowLabel(window({ tokens: 900_000 })) === "7% left"
)

// Clamped where `fractionOf` is not, and that is the point of having both:
// "over the limit" is a real state, "minus 14% left" is not.
check("nothing left is zero", remainingOf(window({ tokens: 1_100_000 })) === 0)
check("an empty chat is all of it", remainingOf(window({ tokens: 0 })) === 1)

// The two are one measurement read two ways, so they must always agree.
check(
  "used and left are complements",
  Math.abs(
    remainingOf(window({ tokens: 500_000 })) +
      fractionOf(window({ tokens: 500_000 })) -
      1
  ) < 1e-9
)

// The detail names the threshold where there is one, because that is what is
// being counted down to — "of 1M" answers a question nobody asked.
check(
  "the detail counts down to the threshold",
  windowDetail(window()) ===
    "947k left before auto-compacting · 20.0k of 967k used"
)
// A countdown to an event that will never happen would be a promise, so a
// window with auto-compaction off says what is used instead.
check(
  "…and does not count down to nothing",
  windowDetail(window({ autoCompactAt: null })) ===
    "20.0k used of 1.0M · auto-compact is off"
)

section("the breakdown answers what is filling the window")

{
  const slices = windowSlices(
    window({
      slices: [
        { name: "Free space", tokens: 980_000, tone: "free", deferred: false },
        { name: "System prompt", tokens: 363, tone: "system", deferred: false },
        {
          name: "Memory files",
          tokens: 8_523,
          tone: "memory",
          deferred: false,
        },
        {
          name: "System tools (deferred)",
          tokens: 13_714,
          tone: "tools",
          deferred: true,
        },
        { name: "Skills", tokens: 6_689, tone: "skills", deferred: false },
        { name: "Messages", tokens: 0, tone: "messages", deferred: false },
      ],
    })
  )
  const names = slices.map((slice) => slice.name)

  // Free space is the remainder and would open the list in almost every chat —
  // the one row that is not an answer to "what is filling this up".
  check("free space is dropped", !names.includes("Free space"))
  check("an empty category is dropped", !names.includes("Messages"))
  check("largest first", names[0] === "Memory files")
  // Kept, because "13.7k you are not paying for" belongs beside the ones you
  // are — but below them, since it is not filling the window either.
  check(
    "deferred is last",
    names[names.length - 1] === "System tools (deferred)"
  )
  check("and it is still there", names.includes("System tools (deferred)"))
}

check(
  "every tone has a colour",
  (
    [
      "system",
      "tools",
      "memory",
      "skills",
      "messages",
      "free",
      "other",
    ] as const
  ).every((tone) => typeof WINDOW_TONES[tone] === "string")
)

section("the compaction line")

check(
  "manual, both sides, timed",
  compactLine({
    id: "1",
    role: "compact",
    trigger: "manual",
    preTokens: 120_000,
    postTokens: 24_000,
    durationMs: 8_400,
  }) === "Compacted · 120k → 24.0k in 8.4s"
)

check(
  "auto says so",
  compactLine({
    id: "1",
    role: "compact",
    trigger: "auto",
    preTokens: 967_000,
    postTokens: 40_000,
  }).startsWith("Auto-compacted · ")
)

// The post figure is optional on the wire, and a line reading `120k → undefined`
// is worse than one that only says what it knows.
check(
  "one side only",
  compactLine({
    id: "1",
    role: "compact",
    trigger: "manual",
    preTokens: 120_000,
  }) === "Compacted · from 120k"
)

section("the CLI's report is narrowed, not trusted")

{
  const read = readWindow({
    totalTokens: 19_254,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    percentage: 2,
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
    model: "claude-fable-5",
    categories: [
      { name: "System prompt", tokens: 363, color: "promptBorder" },
      { name: "System tools", tokens: 3_671, color: "inactive" },
      {
        name: "System tools (deferred)",
        tokens: 13_714,
        color: "inactive",
        isDeferred: true,
      },
      { name: "Memory files", tokens: 8_523, color: "claude" },
      { name: "Skills", tokens: 6_689, color: "warning" },
      { name: "Messages", tokens: 8, color: "purple_FOR_SUBAGENTS_ONLY" },
      { name: "Free space", tokens: 980_746, color: "promptBorder" },
    ],
  })

  check("the total", read.tokens === 19_254)
  check("the threshold", read.autoCompactAt === 967_000)
  check("the model", read.model === "claude-fable-5")
  check("the deferred flag", read.slices[2]?.deferred === true)

  // The CLI's colours are its terminal theme's names — two unrelated categories
  // share `promptBorder` — so the *name* is what decides the tone.
  const tone = (name: string) =>
    read.slices.find((slice) => slice.name === name)?.tone
  check("system prompt", tone("System prompt") === "system")
  check("tools", tone("System tools") === "tools")
  check(
    "deferred tools are still tools",
    tone("System tools (deferred)") === "tools"
  )
  check("memory", tone("Memory files") === "memory")
  check("skills", tone("Skills") === "skills")
  check("messages", tone("Messages") === "messages")
  check("free space", tone("Free space") === "free")
}

{
  // Auto-compaction switched off: the threshold must not survive it, or the bar
  // carries a mark promising something that will never happen.
  const read = readWindow({
    totalTokens: 100,
    rawMaxTokens: 200_000,
    autoCompactThreshold: 180_000,
    isAutoCompactEnabled: false,
  })
  check("a disabled threshold is dropped", read.autoCompactAt === null)
}

{
  // A category this app has never heard of, which is what a CLI release ships.
  const read = readWindow({ categories: [{ name: "Sidechains", tokens: 12 }] })
  check("an unknown category still draws", read.slices[0]?.tone === "other")
}

{
  const read = readWindow(null)
  check(
    "nothing is a window of zero",
    read.tokens === 0 && read.maxTokens === 0
  )
  check("…with no slices", read.slices.length === 0)
  check("…and no threshold", read.autoCompactAt === null)
  check("…which does not divide", fractionOf(read) === 0)
}

finish()
