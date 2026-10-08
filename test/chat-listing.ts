import type { AssistantMessage, WorktreeChat } from "../src/shared/api"
import { WorktreeChats } from "../src/main/worktree-chat"
import { check, finish, section } from "./harness"

/**
 * The chat listing under concurrent edits.
 *
 * Every change to `worktree-chats.json` is a read, a change and a write, and
 * the store only serialises the file operations, not the pairs. A chat
 * created while another chat's append was between its read and its write was
 * gone again once the append wrote back the list it had read, and `send`
 * could not find it. `editChats` is the queue that stops it; this is the race, run
 * against a source that yields between the read and the write the way a file
 * does.
 */

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1))

function source() {
  let listing: WorktreeChat[] = []
  const lines = new Map<string, AssistantMessage[]>()
  const chats = new WorktreeChats(
    {
      folderDir: async () => "/tmp",
      claudeProfiles: async () => [],
      chats: async () => {
        await tick()
        return listing
      },
      saveChats: async (next) => {
        await tick()
        listing = next
      },
      readChat: async (id) => lines.get(id) ?? [],
      writeChat: async (id, messages) => {
        lines.set(id, messages)
      },
      deleteChat: async () => undefined,
    },
    () => undefined
  )
  return { chats, listing: () => listing }
}

section("two chats created at once")
{
  const { chats, listing } = source()
  const [a, b] = await Promise.all([
    chats.create({ folderId: "p" }),
    chats.create({ folderId: "p" }),
  ])
  check("both are in the listing", listing().length === 2)
  check(
    "and are the two that were made",
    listing()
      .map((chat) => chat.id)
      .sort()
      .join() === [a.id, b.id].sort().join()
  )
}

section("a create beside a rename")
{
  const { chats, listing } = source()
  const first = await chats.create({ folderId: "p" })
  const [, second] = await Promise.all([
    chats.rename(first.id, "Named"),
    chats.create({ folderId: "p" }),
  ])
  check("the rename landed", listing()[0]?.title === "Named")
  check(
    "and the chat created meanwhile survived it",
    listing().some((chat) => chat.id === second.id)
  )
}

section("a create beside a delete")
{
  const { chats, listing } = source()
  const first = await chats.create({ folderId: "p" })
  const [, second] = await Promise.all([
    chats.delete(first.id),
    chats.create({ folderId: "p" }),
  ])
  check("the deleted one is gone", !listing().some((c) => c.id === first.id))
  check(
    "the new one is there",
    listing().some((c) => c.id === second.id)
  )
}

section("a seed already listed")
{
  const { chats, listing } = source()
  const seed = { id: "11111111-1111-4111-8111-111111111111", title: "Seeded" }
  const [a, b] = await Promise.all([
    chats.create({ folderId: "p" }, seed),
    chats.create({ folderId: "p" }, seed),
  ])
  check("is one chat, not two", listing().length === 1)
  check("returned to both callers", a.id === b.id && a.title === "Seeded")
}

finish()
