import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { push, upstream } from "../src/main/git"
import { check, finish, section } from "./harness"

/**
 * The `Commits` view's Push, against a real bare remote on disk — a push is
 * git talking to another repository, and nothing short of one says whether
 * `-u origin HEAD` tracks, or whether a rejection comes back as `failed` rather
 * than as the `auth` that would open a terminal for nothing.
 *
 * The `auth` answer itself is not driven here: it needs a key that wants a
 * passphrase, which no test machine should be made to hold.
 */

const run = promisify(execFile)

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: dir })
  return stdout
}

async function commitFile(dir: string, name: string) {
  await writeFile(path.join(dir, name), `${name}\n`)
  await git(dir, "add", name)
  await git(dir, "commit", "-m", `add ${name}`)
}

async function clone(remote: string, into: string) {
  await run("git", ["clone", "--quiet", remote, into])
  await git(into, "config", "user.email", "test@example.com")
  await git(into, "config", "user.name", "Test")
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "vsclaude-push-"))
  const remote = path.join(root, "remote.git")
  const mine = path.join(root, "mine")
  const theirs = path.join(root, "theirs")
  await run("git", ["init", "--quiet", "--bare", "-b", "main", remote])
  await clone(remote, mine)
  await commitFile(mine, "first.txt")
  await git(mine, "push", "--quiet", "-u", "origin", "main")

  section("a branch with an upstream")
  await commitFile(mine, "second.txt")
  const pushed = await push(mine, process.env)
  check("pushes", pushed.ok, pushed)
  check("with plain git push", pushed.command === "git push", pushed.command)
  check(
    "and nothing is ahead after it",
    (await upstream(mine))?.aheadCount === 0
  )

  section("a branch nobody has pushed")
  await git(mine, "switch", "--quiet", "-c", "feature")
  await commitFile(mine, "feature.txt")
  const first = await push(mine, process.env)
  check("pushes", first.ok, first)
  check(
    "to origin under its own name",
    first.command === "git push -u origin HEAD",
    first.command
  )
  check(
    "and tracks it",
    (await upstream(mine))?.name === "origin/feature",
    await upstream(mine)
  )

  section("a push the remote refuses")
  await git(mine, "switch", "--quiet", "main")
  await clone(remote, theirs)
  await commitFile(theirs, "theirs.txt")
  await git(theirs, "push", "--quiet")
  await commitFile(mine, "mine.txt")
  const refused = await push(mine, process.env)
  check("does not push", !refused.ok)
  check(
    "and is a failure, not a terminal to type into",
    !refused.ok && refused.reason === "failed",
    refused
  )
  check(
    "with git's own reason",
    /rejected|fetch first|non-fast-forward/i.test(refused.message),
    refused.message
  )

  await rm(root, { recursive: true, force: true })
  finish()
}

await main()
