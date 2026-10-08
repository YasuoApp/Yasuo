import { readFile } from "node:fs/promises"

import { IPC } from "../src/shared/api"
import {
  channelMethods,
  LOCAL_ONLY,
  PUSHED,
} from "../src/renderer/web/channels"
import { check, finish, section } from "./harness"

/**
 * The browser tab's `window.desktop` against the preload's.
 *
 * The contract is four places by design (`CLAUDE.md`), and the web build reads
 * it from a fifth. What keeps that fifth from drifting is that it is generated
 * from `IPC` — and this, which checks that every key the preload exposes is a
 * key the tab exposes too, calling the same channel. A call added to the four
 * places and named off the rule would fail here rather than as `undefined is
 * not a function` in a tab.
 */

const preload = await readFile(
  new URL("../src/preload/index.ts", import.meta.url),
  "utf8"
)
const body = preload.slice(preload.indexOf("const api: DesktopApi = {"))
const preloadKeys = [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1])

const calls: { channel: string; args: unknown[] }[] = []
const subscribed: string[] = []
const methods = channelMethods(
  async (channel, ...args) => {
    calls.push({ channel, args })
  },
  (channel) => {
    subscribed.push(channel)
    return () => undefined
  }
)

section("every preload key")
{
  check("the preload was read", preloadKeys.length > 50, preloadKeys.length)
  const local = new Set<string>(LOCAL_ONLY)
  const missing = preloadKeys.filter(
    (key) => !(key in methods) && !local.has(key)
  )
  check("exists on the tab's desktop", missing.length === 0, missing)
}

section("calls go to their own channel")
{
  const gitLog = methods.gitLog as (...args: unknown[]) => Promise<void>
  await gitLog("folder", 20, undefined)
  check(
    "gitLog → git:log, arguments untouched",
    calls[0]?.channel === IPC.gitLog && calls[0].args.length === 3,
    calls[0]
  )

  const onTreeChanged = methods.onTreeChanged as (
    listener: () => void
  ) => () => void
  onTreeChanged(() => undefined)
  check(
    "onTreeChanged subscribes to files:tree-changed",
    subscribed[0] === IPC.treeChanged
  )
}

section("every pushed channel is one the preload subscribes to")
{
  for (const key of PUSHED) {
    const name = `on${key.charAt(0).toUpperCase()}${key.slice(1)}`
    check(`${name} is in the preload`, preloadKeys.includes(name))
  }
}

finish()
