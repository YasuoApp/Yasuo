/**
 * The smallest thing that can hold a check.
 *
 * No test framework: these run under `bun <file>` with nothing installed for
 * them, which is the difference between tests that exist and tests that are a
 * dependency away from existing. Add a real runner when there is something a
 * runner would give — parallelism, watch mode — rather than up front.
 */

let failures = 0
let checks = 0

export function check(label: string, condition: boolean, detail?: unknown) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
  if (detail !== undefined) {
    console.log(`       ${JSON.stringify(detail)?.slice(0, 400)}`)
  }
}

export function section(title: string) {
  console.log(`\n# ${title}`)
}

/** Prints the tally and sets the exit code, which is what CI reads. */
export function finish() {
  if (failures === 0) {
    console.log(`\n${checks} checks passed`)
    process.exit(0)
  }
  console.log(`\n${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
