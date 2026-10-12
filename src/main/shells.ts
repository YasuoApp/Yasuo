import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

import type { TerminalShell } from "../shared/api"

/** A shell the dock can start: what the renderer is shown, and the command
 * line main keeps to itself. */
export type ShellProfile = TerminalShell & { file: string; args: string[] }

type Machine = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (file: string) => boolean
  /** `/etc/shells`, or null where there is none. */
  etcShells: string | null
}

/**
 * The shells installed on this machine, the default first — what the dock's
 * `+` menu lists, as VS Code's terminal profiles do.
 *
 * Found by looking where each is installed rather than by asking a shell,
 * because the question is which shells there are, and on Windows the answer is
 * a handful of well-known paths that no single shell's PATH covers: Git Bash
 * is not on PATH at all unless the installer was told to put it there.
 *
 * The default is the one `shell()` in `shell-env.ts` would have started, so a
 * plain `+` opens what it always has.
 */
export function shellProfiles(machine: Machine): ShellProfile[] {
  const found =
    machine.platform === "win32" ? windowsShells(machine) : unixShells(machine)
  const preferred =
    machine.platform === "win32" ? machine.env.COMSPEC : machine.env.SHELL
  const at = preferred
    ? found.findIndex((profile) => samePath(profile.file, preferred, machine))
    : -1
  if (at > 0) found.unshift(...found.splice(at, 1))
  return found
}

function samePath(a: string, b: string, machine: Machine): boolean {
  return machine.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b
}

function windowsShells({ env, exists }: Machine): ShellProfile[] {
  const join = path.win32.join
  const system = join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32")
  const programFiles = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramW6432,
  ].filter((dir): dir is string => Boolean(dir))
  const onPath = (name: string) =>
    (env.Path ?? env.PATH ?? "")
      .split(";")
      .filter(Boolean)
      .map((dir) => join(dir, name))
  const first = (candidates: (string | undefined)[]) =>
    candidates.find((file): file is string => Boolean(file && exists(file)))

  const profiles: ShellProfile[] = []
  const add = (
    id: string,
    name: string,
    file: string | undefined,
    args: string[] = []
  ) => {
    if (file) profiles.push({ id, name, file, args })
  }

  // PowerShell 7 installs beside the one Windows ships rather than over it, so
  // both are listed, as VS Code lists them.
  add(
    "pwsh",
    "PowerShell",
    first([
      ...programFiles.map((dir) => join(dir, "PowerShell", "7", "pwsh.exe")),
      ...onPath("pwsh.exe"),
    ]),
    ["-NoLogo"]
  )
  add(
    "powershell",
    "Windows PowerShell",
    first([join(system, "WindowsPowerShell", "v1.0", "powershell.exe")]),
    ["-NoLogo"]
  )
  add("cmd", "Command Prompt", first([join(system, "cmd.exe"), env.COMSPEC]))
  // `bin\bash.exe` rather than `git-bash.exe`, which opens a mintty window of
  // its own instead of running in this pty. Found beside a `git.exe` on PATH
  // too — `<Git>\cmd\git.exe` — for an install outside Program Files.
  add(
    "git-bash",
    "Git Bash",
    first([
      ...programFiles.map((dir) => join(dir, "Git", "bin", "bash.exe")),
      env.LOCALAPPDATA &&
        join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"),
      ...onPath("git.exe").map((git) =>
        join(path.win32.dirname(path.win32.dirname(git)), "bin", "bash.exe")
      ),
    ]),
    ["--login", "-i"]
  )
  add("wsl", "WSL", first([join(system, "wsl.exe")]))
  return profiles
}

/**
 * `/etc/shells`, one entry per shell. The file lists `/bin/bash` and
 * `/usr/bin/bash` side by side on most Linux distributions, and both are the
 * same program, so the first of a name is the one kept — unless `$SHELL` names
 * the other, which is then the one the user meant.
 */
function unixShells({ env, exists, etcShells }: Machine): ShellProfile[] {
  const listed = (etcShells ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("/"))
  if (env.SHELL) listed.unshift(env.SHELL)

  const byName = new Map<string, ShellProfile>()
  for (const file of listed) {
    const name = path.posix.basename(file)
    if (byName.has(name) || !exists(file)) continue
    // `-l` for the reason `shell()` gives it: a GUI app's PATH is bare without
    // the profile.
    byName.set(name, { id: name, name, file, args: ["-l"] })
  }
  return [...byName.values()]
}

/** This machine's shells, read once a run — a shell installed while the app is
 * open shows up on the next launch. */
let installed: Promise<ShellProfile[]> | undefined

export function installedShells(): Promise<ShellProfile[]> {
  installed ??= readFile("/etc/shells", "utf8")
    .catch(() => null)
    .then((etcShells) =>
      shellProfiles({
        platform: process.platform,
        env: process.env,
        exists: existsSync,
        etcShells: process.platform === "win32" ? null : etcShells,
      })
    )
  return installed
}
