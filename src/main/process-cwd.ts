import { execFile } from "node:child_process"
import { readlink } from "node:fs/promises"

/**
 * The working directory a process is in right now, or null when it cannot be
 * said — the process has gone, or the platform has no way to ask.
 *
 * What a dock tab is named after. The shell's own prompt knows, but getting it
 * out of the shell means an OSC 7 escape the user's `.zshrc` would have to be
 * edited to print, and this app does not write into somebody's dotfiles; the
 * kernel answers the same question without the shell's cooperation.
 *
 * Free of `electron`, like the rest of what main can test.
 */
export async function processCwd(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    return readlink(`/proc/${pid}/cwd`).catch(() => null)
  }
  if (process.platform !== "darwin") return null

  // `-Fn` is the machine-readable form: one field per line, the name prefixed
  // with `n`. `-a` makes the two filters an AND rather than lsof's default OR.
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { timeout: 2000 },
      (error, stdout) => {
        if (error) return resolve(null)
        const line = stdout.split("\n").find((entry) => entry.startsWith("n"))
        resolve(line ? line.slice(1) : null)
      }
    )
  })
}
