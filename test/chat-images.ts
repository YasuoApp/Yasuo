import type { ChatImage } from "../src/shared/api"
import {
  attachedIn,
  imageTag,
  namedIn,
  withoutTag,
} from "../src/renderer/lib/worktree-chat/images"
import { check, finish, section } from "./harness"

/**
 * What a message with pictures in it sends.
 *
 * The tags are text the person can edit, so what is worth testing is what
 * happens once they have: a deleted tag takes its picture with it, and what is
 * left is renumbered so the message never names a picture it did not carry.
 */

const image = (data: string): ChatImage => ({ mediaType: "image/png", data })
const a = image("a")
const b = image("b")
const c = image("c")

section("attachedIn")
{
  const plain = attachedIn("no pictures here", [a])
  check("no tag sends no picture", plain.images.length === 0, plain)
  check("and leaves the text alone", plain.text === "no pictures here")

  const both = attachedIn(`${imageTag(1)} vs ${imageTag(2)}`, [a, b])
  check(
    "every tag sends its picture",
    both.images.length === 2 && both.images[0] === a && both.images[1] === b,
    both
  )
  check(
    "numbers already in order stay",
    both.text === "[Image #1] vs [Image #2]"
  )

  const second = attachedIn(`look at ${imageTag(2)}`, [a, b])
  check(
    "a deleted tag drops its picture",
    second.images.length === 1 && second.images[0] === b,
    second
  )
  check("and the rest are renumbered", second.text === "look at [Image #1]")

  const moved = attachedIn(`${imageTag(3)} then ${imageTag(1)}`, [a, b, c])
  check(
    "order is the text's, not the draft's",
    moved.images[0] === c && moved.images[1] === a,
    moved
  )
  check("renumbered by position", moved.text === "[Image #1] then [Image #2]")

  const twice = attachedIn(`${imageTag(1)} and again ${imageTag(1)}`, [a])
  check("a tag said twice sends one picture", twice.images.length === 1, twice)
  check(
    "and keeps one number",
    twice.text === "[Image #1] and again [Image #1]"
  )

  const stray = attachedIn(`${imageTag(4)} is not held`, [a])
  check(
    "a tag naming nothing is left as text",
    stray.text === "[Image #4] is not held"
  )
  check("and sends nothing", stray.images.length === 0)
}

section("namedIn")
{
  const shown = namedIn(`${imageTag(3)} then ${imageTag(1)}`, [a, b, c])
  check(
    "a thumbnail for each picture the text names, in the order added",
    shown.length === 2 &&
      shown[0]?.n === 1 &&
      shown[0]?.image === a &&
      shown[1]?.n === 3 &&
      shown[1]?.image === c,
    shown
  )
  check("none for a draft without tags", namedIn("plain", [a]).length === 0)
}

section("withoutTag")
{
  check(
    "takes the tag and the space before it",
    withoutTag(`look ${imageTag(1)} here`, 1) === "look here"
  )
  check(
    "a tag at the start goes too",
    withoutTag(`${imageTag(2)} and ${imageTag(1)}`, 2) === ` and ${imageTag(1)}`
  )
  check(
    "#1 does not take #10",
    withoutTag(`${imageTag(10)}`, 1) === imageTag(10)
  )
}

finish()
