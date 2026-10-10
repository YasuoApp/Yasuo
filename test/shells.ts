import { shellProfiles } from "../src/main/shells"
import { check, finish, section } from "./harness"

/**
 * The dock's `+` menu: which shells a machine has, and which one is the
 * default. Against a made-up file system, because the machine that matters
 * most here — Windows — is not the one these tests run on, and the paths are
 * the whole of what is being checked.
 */

const ids = (profiles: { id: string }[]) => profiles.map((p) => p.id).join(",")

section("Windows")
{
  const files = new Set([
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Windows\\System32\\wsl.exe",
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "D:\\Tools\\Git\\bin\\bash.exe",
  ])
  const machine = {
    platform: "win32" as const,
    env: {
      SystemRoot: "C:\\Windows",
      ProgramFiles: "C:\\Program Files",
      COMSPEC: "C:\\WINDOWS\\system32\\cmd.exe",
      Path: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd",
    },
    exists: (file: string) => files.has(file),
    etcShells: null,
  }
  const found = shellProfiles(machine)

  check(
    "lists every installed shell, COMSPEC's first",
    ids(found) === "cmd,pwsh,powershell,git-bash,wsl",
    ids(found)
  )
  check(
    "finds Git Bash beside a git.exe on PATH",
    found.find((p) => p.id === "git-bash")?.file ===
      "D:\\Tools\\Git\\bin\\bash.exe"
  )
  check(
    "starts Git Bash as a login shell",
    found.find((p) => p.id === "git-bash")?.args.join(" ") === "--login -i"
  )

  const bare = shellProfiles({
    ...machine,
    env: { SystemRoot: "C:\\Windows" },
    exists: (file) => file.endsWith("cmd.exe"),
  })
  check("leaves out what is not installed", ids(bare) === "cmd", ids(bare))
}

section("macOS and Linux")
{
  const etcShells = [
    "# List of acceptable shells",
    "/bin/sh",
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/zsh",
    "/usr/local/bin/fish",
    "",
  ].join("\n")
  const files = new Set(["/bin/sh", "/bin/bash", "/usr/bin/bash", "/bin/zsh"])
  const found = shellProfiles({
    platform: "darwin",
    env: { SHELL: "/bin/zsh" },
    exists: (file) => files.has(file),
    etcShells,
  })

  check(
    "$SHELL first, one per name, missing ones dropped",
    ids(found) === "zsh,sh,bash",
    ids(found)
  )
  check(
    "keeps the first path of a name",
    found.find((p) => p.id === "bash")?.file === "/bin/bash"
  )

  const noSlash = shellProfiles({
    platform: "linux",
    env: { SHELL: "/usr/bin/bash" },
    exists: (file) => files.has(file),
    etcShells,
  })
  check(
    "$SHELL's own spelling wins over /etc/shells'",
    noSlash[0]?.file === "/usr/bin/bash",
    noSlash[0]
  )
}

finish()
