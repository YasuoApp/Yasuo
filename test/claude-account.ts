import { readAuthStatus } from "../src/main/claude-auth"
import { profileDir, withConfigDirs } from "../src/main/claude-profiles"
import {
  accountCaption,
  accountLabel,
  accountLine,
} from "../src/renderer/lib/worktree-chat/claude-profiles"
import { check, finish, section } from "./harness"

/**
 * Whether a profile's directory is signed in — the badge in Settings › Claude.
 *
 * Tested for the reason `mcp-servers.ts` is: every field here was written by a
 * process this app does not control, and the badge is what somebody trusts
 * before starting a turn under an identity. The cases that matter are the ones
 * the CLI is free to change under us — a login with no subscription, a status
 * that is not JSON at all — and the one distinction the section exists to
 * draw, which is that "not signed in" and "no such directory" are different
 * problems with different fixes.
 */

const signedIn = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "hung@example.com",
  orgId: "783aed7e",
  orgName: "AZoom",
  subscriptionType: "team",
})

section("readAuthStatus: the CLI's own answer")

const account = readAuthStatus("/Users/hung/.claude-group/work", signedIn)
check("a login is signed in", account.state === "signedIn", account)
check("carries the email", account.email === "hung@example.com", account)
check("carries the organisation", account.organization === "AZoom", account)
check("carries the plan", account.plan === "team", account)
check("carries the method", account.method === "claude.ai", account)
check(
  "answers about the directory it was asked for",
  account.configDir === "/Users/hung/.claude-group/work",
  account
)

const out = readAuthStatus(
  "/Users/hung/.claude-group/spare",
  JSON.stringify({ loggedIn: false, authMethod: "none" })
)
check("a directory nobody logged into is signed out", out.state === "signedOut")
check("and names nobody", out.email === null && out.organization === null, out)

// An API-key login has no subscription and no organisation, and must not be
// read as a failure for want of fields this app only happens to draw.
const key = readAuthStatus(
  "",
  JSON.stringify({ loggedIn: true, authMethod: "apiKey", email: "" })
)
check("an API-key login is still signed in", key.state === "signedIn", key)
check("an empty field is null, not an empty string", key.email === null, key)
check("no plan is null", key.plan === null, key)

// The CLI prints an update notice before its JSON often enough to matter.
const noisy = readAuthStatus("", `Some notice\n${signedIn}`)
check(
  "a preamble before the JSON is skipped",
  noisy.state === "signedIn",
  noisy
)

const broken = readAuthStatus("", "error: unknown command 'auth'")
check("output that is not JSON is an error", broken.state === "error", broken)
check(
  "and keeps what the CLI actually said",
  broken.error === "error: unknown command 'auth'",
  broken
)

section("accountLabel / accountCaption: what the row says")

check(
  "unchecked is its own quiet state, not a good one",
  accountLabel(undefined).tone === "off",
  accountLabel(undefined)
)
check("signed in is good", accountLabel(account).tone === "good")
check(
  "signed out and missing are different sentences",
  accountLabel(out).label !== accountLabel({ ...out, state: "missing" }).label
)
check(
  "the caption names who it is",
  accountCaption(account) === "hung@example.com · AZoom · team · claude.ai",
  accountCaption(account)
)
check(
  "and says nothing for a directory that is not signed in",
  accountCaption(out) === "",
  accountCaption(out)
)
check(
  "an API-key login's caption is what it has",
  accountCaption(key) === "apiKey",
  accountCaption(key)
)

section("accountLine: the one line the composer's picker has room for")

check(
  "a working login is named, not labelled",
  accountLine(account).text === "hung@example.com",
  accountLine(account)
)
check(
  "a login with no email falls back to the organisation",
  accountLine({ ...account, email: null }).text === "AZoom",
  accountLine({ ...account, email: null })
)
check(
  "and to a plain word when it has neither, rather than to nothing",
  accountLine({ ...account, email: null, organization: null }).text ===
    "Signed in"
)
check(
  "anything that will not run says so, loudly",
  accountLine(out).text === accountLabel(out).label &&
    accountLine(out).tone === "bad",
  accountLine(out)
)
check(
  "and an unchecked row is quiet",
  accountLine(undefined).tone === "off",
  accountLine(undefined)
)

section("profileDir: the path nobody has to type")

const root = "/Users/hung/.vsclaude/claude-profiles"

check(
  "a profile's directory is named after it",
  profileDir(root, "Work", []) === `${root}/work`,
  profileDir(root, "Work", [])
)
check(
  "spaces and case become one slug, not a path with a space in it",
  profileDir(root, "My Second Account", []) === `${root}/my-second-account`,
  profileDir(root, "My Second Account", [])
)
// A name is free text, so it can be entirely punctuation, and a directory named
// "" would be the profiles root itself — every such profile the same account.
check(
  "a name with nothing usable in it still lands somewhere of its own",
  profileDir(root, "!!!", []) === `${root}/profile`,
  profileDir(root, "!!!", [])
)

// Two profiles on one directory are a single login wearing two names — the
// renderer's `accounts` map is keyed by directory, so the second row would
// silently draw the first one's account.
check(
  "a directory already taken is not handed out twice",
  profileDir(root, "Work", [`${root}/work`]) === `${root}/work-2`
)
check(
  "and it keeps counting",
  profileDir(root, "Work", [`${root}/work`, `${root}/work-2`]) ===
    `${root}/work-3`
)

section("withConfigDirs: filling in what the renderer does not name")

const named = [{ id: "a", name: "Work", configDir: `${root}/work` }]
check(
  "profiles that all have a directory are returned as they are",
  withConfigDirs(named, root) === named
)

const filled = withConfigDirs(
  [
    { id: "a", name: "Work", configDir: `${root}/work` },
    { id: "b", name: "Work", configDir: "" },
    { id: "c", name: "Work", configDir: "   " },
  ],
  root
)
check(
  "an existing path is left exactly alone",
  filled[0]?.configDir === `${root}/work`,
  filled
)
check(
  "a new profile clears the one already there",
  filled[1]?.configDir === `${root}/work-2`,
  filled
)
check(
  "and clears the one filled in beside it",
  filled[2]?.configDir === `${root}/work-3`,
  filled
)

// The field this replaced accepted anything, including the `~/…` paths its own
// placeholder suggested. Those profiles are on disk and are not to be renamed
// out from under the login they already hold.
const legacy = withConfigDirs(
  [
    { id: "a", name: "Hung", configDir: "~/.claude-group/hung" },
    { id: "b", name: "Personal", configDir: "" },
  ],
  root
)
check(
  "a path written by the old field is kept",
  legacy[0]?.configDir === "~/.claude-group/hung",
  legacy
)
check(
  "and the profile beside it still gets one",
  legacy[1]?.configDir === `${root}/personal`,
  legacy
)

finish()
