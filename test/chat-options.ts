import {
  chatOptions,
  DEFAULT_CHAT_EFFORT,
  type WorktreeChatOptions,
} from "../src/shared/api"
import { check, finish, section } from "./harness"

/**
 * A chat's options as both sides of the contract read them.
 *
 * The one function main builds a turn's argument list out of and the composer
 * draws its toolbar from, which is why it is worth a test of its own: a
 * disagreement between the two is a toolbar saying `Edits` over a turn that ran
 * read-only, and neither side would report it.
 *
 * Everything here is about a record that came off disk — written by an older
 * build, by a newer one, or by nothing at all — since a record written by this
 * build is the uninteresting case.
 */

section("a record with nothing on it")

check(
  "no options at all is whatever a new chat gets",
  chatOptions(undefined).permission === "edits" &&
    chatOptions(undefined).model === "default" &&
    chatOptions(undefined).effort === DEFAULT_CHAT_EFFORT
)

/*
 * A null effort is the app's default rather than "no answer", which is the one
 * read here that is not a passthrough. The picker's `Default` row is gone (see
 * `DEFAULT_CHAT_EFFORT`), so a record still carrying null — every chat written
 * before that — would otherwise leave the toolbar with no level to tick over a
 * turn that ran at one.
 */
check(
  "a null effort off disk reads as the level a new chat gets",
  chatOptions({ model: "opus", effort: null, permission: "edits" }).effort ===
    DEFAULT_CHAT_EFFORT
)

check(
  "but `Inherit` keeps its null — a level here would override the setting " +
    "that row exists to defer to",
  chatOptions({ model: null, effort: null, permission: "edits" }).effort ===
    null
)

/*
 * The one migration here that changes what a turn runs on.
 *
 * A record with no `options` was written before there was a toolbar, so nobody
 * ever chose anything for it — and what "nobody chose" means is now the CLI's
 * own `default` row rather than a `--model` left off entirely. The difference
 * matters because leaving it off runs the turn on whatever
 * `~/.claude/settings.json` says, which is how every chat in the app came to be
 * on Opus without anything on screen saying so. A record that *does* say
 * `model: null` chose to inherit, and keeps it.
 */
check(
  "a record that chose to inherit keeps inheriting",
  chatOptions({ model: null, effort: null, permission: "edits" }).model === null
)

section("the plan toggle this replaced")

check(
  "a chat left in plan mode comes back in it",
  chatOptions({ model: null, effort: null, plan: true } as WorktreeChatOptions)
    .permission === "plan"
)

check(
  "a chat with the toggle off is on the default rather than read-only",
  chatOptions({ model: null, effort: null, plan: false } as WorktreeChatOptions)
    .permission === "edits"
)

check(
  "the legacy field is never handed back, so nothing can read it by accident",
  chatOptions({ model: null, effort: null, plan: true } as WorktreeChatOptions)
    .plan === undefined
)

check(
  "a permission on the record wins over a toggle left beside it",
  chatOptions({
    model: null,
    effort: null,
    permission: "full",
    plan: true,
  }).permission === "full"
)

section("a record this build does not understand")

check(
  "a mode from a newer build falls back rather than drawing a blank",
  chatOptions({
    model: null,
    effort: null,
    permission: "yolo" as WorktreeChatOptions["permission"],
  }).permission === "edits"
)

section("what the toolbar chose")

check(
  "a model and an effort survive untouched",
  chatOptions({ model: "haiku", effort: "low", permission: "read" }).model ===
    "haiku" &&
    chatOptions({ model: "haiku", effort: "low", permission: "read" })
      .effort === "low"
)

section("the chat's switched-off MCP tools")

check(
  "a record from before the field has none off",
  chatOptions({ model: null, effort: null, permission: "edits" }).disabledTools
    ?.length === 0
)
check("a new chat has none off", chatOptions(null).disabledTools?.length === 0)
check(
  "sorted and deduplicated, so the same set is the same session signature",
  chatOptions({
    model: null,
    effort: null,
    permission: "edits",
    disabledTools: ["mcp__b", "mcp__a__x", "mcp__b"],
  }).disabledTools?.join() === "mcp__a__x,mcp__b"
)
check(
  "anything that is not a list of names reads as none",
  chatOptions({
    model: null,
    effort: null,
    permission: "edits",
    disabledTools: "mcp__a" as unknown as string[],
  }).disabledTools?.length === 0
)

finish()
