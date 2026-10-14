import type { AssistantMessage } from "../src/shared/api"
import { linksIn, mediaOf } from "../src/renderer/lib/chat/media"
import { check, finish, section } from "./harness"

/**
 * A chat's shared media — which pictures, files and links are listed, in what
 * order, and which line each one lands on.
 */

section("pictures, from both sides, newest first")
{
  const lines: AssistantMessage[] = [
    {
      id: "u1",
      role: "user",
      text: "[Image #1] [Image #2]",
      images: ["a.png", "b.png"],
    },
    {
      id: "t1",
      role: "tool",
      name: "Read",
      summary: "x.png",
      images: ["c.png"],
    },
    { id: "a1", role: "assistant", text: "Done." },
  ]
  const { images } = mediaOf(lines)
  check("all three", images.length === 3, images)
  check(
    "newest first",
    images.map((i) => i.file).join() === "c.png,b.png,a.png"
  )
  check(
    "each on its line",
    images[0]?.lineId === "t1" && images[2]?.lineId === "u1"
  )
}

section("files the chat wrote, once each, at the last write")
{
  const lines: AssistantMessage[] = [
    { id: "t1", role: "tool", name: "Write", summary: "", path: "/r/a.ts" },
    { id: "t2", role: "tool", name: "Read", summary: "", path: "/r/b.ts" },
    {
      id: "t3",
      role: "tool",
      name: "Edit",
      summary: "",
      path: "/r/c.ts",
      failed: true,
    },
    { id: "t4", role: "tool", name: "Edit", summary: "", path: "/r/d.ts" },
    { id: "t5", role: "tool", name: "Edit", summary: "", path: "/r/a.ts" },
  ]
  const { files } = mediaOf(lines)
  check("a read and a failure are not writes", files.length === 2, files)
  check(
    "re-ordered by the last write",
    files.map((f) => f.path).join() === "/r/a.ts,/r/d.ts"
  )
  check("lands on the last write", files[0]?.lineId === "t5")
}

section("links")
{
  check(
    "trailing punctuation is the sentence's",
    linksIn("See https://example.com/a.").join() === "https://example.com/a"
  )
  check(
    "a markdown link's bracket is not the URL's",
    linksIn("[docs](https://x.dev/p?q=1)").join() === "https://x.dev/p?q=1"
  )
  check("no scheme, no link", linksIn("example.com").length === 0)

  const lines: AssistantMessage[] = [
    { id: "u1", role: "user", text: "look at https://a.dev" },
    { id: "a1", role: "assistant", text: "https://b.dev and https://a.dev" },
    { id: "t1", role: "tool", name: "Bash", summary: "curl https://c.dev" },
  ]
  const { links } = mediaOf(lines)
  check(
    "only what was said, once each",
    links.map((l) => l.url).join() === "https://a.dev,https://b.dev",
    links
  )
}

section("a subagent's media lands on the row that ran it")
{
  const lines: AssistantMessage[] = [
    {
      id: "agent",
      role: "tool",
      name: "Agent",
      summary: "look",
      toolId: "call1",
    },
    {
      id: "s1",
      role: "tool",
      name: "Read",
      summary: "",
      images: ["s.png"],
      parent: "call1",
    },
  ]
  check("on the Agent row", mediaOf(lines).images[0]?.lineId === "agent")
}

finish()
