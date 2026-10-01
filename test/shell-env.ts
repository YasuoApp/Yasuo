import { mergeShellEnv, parseEnv } from "../src/main/shell-env"
import { check, finish, section } from "./harness"

/**
 * What a spawned `claude` is handed, out of the login shell's env.
 *
 * Worth a test because the failure is silent and far away: a variable lost here
 * is an MCP server that does not start, in a chat, with nothing in any log
 * pointing back at this file — and "it works in the terminal" is the only clue.
 */

section("reading env -0")

const block = "A=1\0MULTI=line one\nline two\0EQ=a=b\0\0"
const parsed = parseEnv(block)

check("a plain pair reads back", parsed.A === "1")
check(
  // Why NUL and not newline: a value may hold one.
  "a value with a newline is kept whole",
  parsed.MULTI === "line one\nline two"
)
check("only the first = splits", parsed.EQ === "a=b")
check("the trailing empty entry is no key", Object.keys(parsed).length === 3)

section("merging it under what was inherited")

const merged = mergeShellEnv(
  { HOME: "/Users/me", PATH: "/usr/bin:/bin:/plugin/bin", LANG: "ja_JP.UTF-8" },
  {
    HOME: "/somewhere/else",
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    FIGMA_TOKEN: "t",
    LANG: "en_US.UTF-8",
    SHLVL: "2",
    PWD: "/tmp",
    _: "/usr/bin/env",
  }
)

check(
  // The case this exists for: a token exported in `.zshrc`.
  "a variable only the shell has is filled in",
  merged.FIGMA_TOKEN === "t"
)
check(
  "an inherited value wins, so a terminal launch keeps its newer env",
  merged.HOME === "/Users/me" && merged.LANG === "ja_JP.UTF-8"
)
check(
  "PATH is merged, the shell's first and nothing twice",
  merged.PATH === "/opt/homebrew/bin:/usr/bin:/bin:/plugin/bin"
)
check(
  "the probe shell's own variables are not passed on",
  merged.SHLVL === undefined &&
    merged.PWD === undefined &&
    merged._ === undefined
)

finish()
