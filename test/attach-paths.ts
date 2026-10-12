import { quotePath, relativeTo } from "../src/renderer/lib/files/paths"
import { check, finish, section } from "./harness"

/**
 * A picked file's path, as a chat's composer writes it.
 *
 * The turn runs in the checkout, so `src/main/ipc.ts` is both what the agent
 * would have typed itself and short enough to read in a message — but only for
 * a file that is actually in there. A file from somewhere else has to keep its
 * absolute path: the alternative is a `../..` chain that reads like a path in
 * this checkout and is not one, which is the failure worth a test.
 *
 * Both separators, like everything else in `lib/files/paths.ts` — the paths come
 * from `node:path` in the main process, so on Windows they arrive with
 * backslashes.
 */

section("inside the checkout")

check(
  "a file under the root loses the root",
  relativeTo("/checkouts/fix", "/checkouts/fix/src/main/ipc.ts") ===
    "src/main/ipc.ts"
)

check(
  "a root written with a trailing separator does not eat the first character",
  relativeTo("/checkouts/fix/", "/checkouts/fix/package.json") ===
    "package.json"
)

check(
  "a file directly in the root is just its name",
  relativeTo("/checkouts/fix", "/checkouts/fix/README.md") === "README.md"
)

check(
  "backslashes are the same question",
  relativeTo("C:\\checkouts\\fix", "C:\\checkouts\\fix\\src\\main.ts") ===
    "src\\main.ts"
)

section("outside it")

check(
  "a file in another checkout keeps its absolute path",
  relativeTo("/checkouts/fix", "/checkouts/spike/src/main.ts") ===
    "/checkouts/spike/src/main.ts"
)

check(
  "a sibling whose name starts with the root's is not inside it",
  relativeTo("/checkouts/fix", "/checkouts/fix-2/notes.md") ===
    "/checkouts/fix-2/notes.md"
)

check(
  // Which is what the Changes list draws no directory line for.
  "there is nothing left of the root itself",
  relativeTo("/checkouts/fix", "/checkouts/fix") === "" &&
    relativeTo("/checkouts/fix/", "/checkouts/fix") === ""
)

check(
  "with no root to be relative to, the path is what it was",
  relativeTo("", "/checkouts/fix/src/main.ts") === "/checkouts/fix/src/main.ts"
)

section("a path with a space in it")

check(
  // Which is every screenshot macOS has ever taken.
  "a name with spaces is quoted, so the message says where it ends",
  quotePath("/Users/me/Desktop/Screenshot 2026-08-27 at 9.14.12 PM.png") ===
    String.raw`"/Users/me/Desktop/Screenshot 2026-08-27 at 9.14.12 PM.png"`
)

check(
  "one without them is left alone",
  quotePath("src/main/ipc.ts") === "src/main/ipc.ts"
)

check(
  "and one already quoted is not quoted twice",
  quotePath(String.raw`"a file.png"`) === String.raw`"a file.png"`
)

finish()
