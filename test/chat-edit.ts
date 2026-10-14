import type { AssistantMessage } from "../src/shared/api"
import { editedAfter } from "../src/renderer/lib/chat/edit"
import { check, finish, section } from "./harness"

/**
 * What an edited message leaves behind — `lib/chat/edit.ts`. The
 * bubble names these before the edit is sent, since the edit cuts the
 * conversation and not the working tree.
 */

let next = 0
const id = () => `l${(next += 1)}`
const user = (text: string): AssistantMessage => ({
  id: id(),
  role: "user",
  text,
})
const tool = (
  name: string,
  path: string,
  extra: Partial<Extract<AssistantMessage, { role: "tool" }>> = {}
): AssistantMessage => ({
  id: id(),
  role: "tool",
  name,
  summary: path,
  path,
  ...extra,
})

section("the turns after the message")

const chat: AssistantMessage[] = [
  user("one"),
  tool("Edit", "/a/early.ts"),
  user("two"),
  tool("Read", "/a/read.ts"),
  tool("Write", "/a/new.ts"),
  tool("Edit", "/a/failed.ts", { failed: true }),
  { ...tool("Edit", "/a/agent.ts"), parent: "t1" },
  user("three"),
  tool("Edit", "/a/new.ts"),
  tool("mcp__x__apply", "/a/stat.ts", { stat: "+1 −0" }),
]

const after = editedAfter(chat, 1)
check(
  "what the message and every turn after it wrote, once each",
  after.join() === "/a/new.ts,/a/agent.ts,/a/stat.ts",
  after
)
check("not what was only read", !after.includes("/a/read.ts"))
check("not what an earlier turn wrote", !after.includes("/a/early.ts"))
check("not a call that failed", !after.includes("/a/failed.ts"))
check(
  "the last message leaves its own turn's files",
  editedAfter(chat, 2).join() === "/a/new.ts,/a/stat.ts"
)
check(
  "a message past the end leaves nothing",
  editedAfter(chat, 5).length === 0
)

finish()
