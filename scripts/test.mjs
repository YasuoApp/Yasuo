/**
 * Runs every test file under `test/`.
 *
 * The list used to be spelled out in package.json, and it fell behind: nine of
 * the fourteen files were never run by `bun test`, and one of them had been
 * failing against a refactor nobody noticed. Discovering the files means adding
 * one cannot be forgotten — dropping a `.ts` into `test/` is the whole of it.
 *
 * Each file is its own process because `harness.finish()` sets the exit code
 * with `process.exit`, which is also what makes one file's failure legible
 * rather than something the next file's output buries.
 */
import { spawnSync } from "node:child_process"
import console from "node:console"
import { readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const testDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test")

const files = readdirSync(testDir)
  .filter((name) => name.endsWith(".ts"))
  // `harness.ts` is the thing being imported, not a test; `*.local.*` is
  // gitignored scratch that may not even run.
  .filter((name) => name !== "harness.ts" && !name.includes(".local."))
  .sort()

const failed = []

for (const name of files) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`)
  const run = spawnSync("bun", [join(testDir, name)], { stdio: "inherit" })
  if (run.status !== 0) failed.push(name)
}

console.log(`\n${"=".repeat(64)}`)
if (failed.length === 0) {
  console.log(`${files.length} test files passed`)
  process.exit(0)
}
console.log(`${failed.length} of ${files.length} test files FAILED:`)
for (const name of failed) console.log(`  ${name}`)
process.exit(1)
