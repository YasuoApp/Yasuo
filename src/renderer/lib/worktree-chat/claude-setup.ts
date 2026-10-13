import type { ClaudeAccount, ClaudeVersions } from "@shared/api"

/**
 * Where a machine is on the way to its first chat: nothing known yet, no
 * `claude` to run, a `claude` nobody is signed in to, or ready.
 *
 * Every chat is the user's own `claude`, so a machine without one used to find
 * out on its first message, as an error line in a transcript. The setup screen
 * (`claude-setup.tsx`) asks the same two questions at launch instead — but it
 * is a gate somebody can walk past, because both answers come through a login
 * shell's PATH (`shell-env.ts`) that can be wrong about a `claude` that is
 * there, and the Explorer, Git and the dock work without one.
 */
export type SetupStep = "checking" | "install" | "signIn" | "ready"

export function setupStep({
  versions,
  account,
  hasProfiles,
}: {
  /** `claudeVersions()`, or undefined while it is still being asked. */
  versions: ClaudeVersions | undefined
  /** The default login's `claudeAccount("")`, likewise. */
  account: ClaudeAccount | undefined
  /** Whether the workspace has any `CLAUDE_CONFIG_DIR` profiles. */
  hasProfiles: boolean
}): SetupStep {
  if (!versions) return "checking"
  if (!versions.cli) return "install"
  if (!account) return "checking"
  // Only a definite "signed out" asks for a login. `error` is also an old CLI
  // with no `auth status` at all, which can chat perfectly well; and somebody
  // with profiles may never use the default login, so its being signed out says
  // nothing about whether a chat will work.
  if (account.state === "signedOut" && !hasProfiles) return "signIn"
  return "ready"
}

/**
 * The installer's one line for this platform, as the Claude Code docs give it —
 * the native installer, which needs no Node, rather than the npm package.
 */
export function installCommand(platform: string): string {
  return platform === "win32"
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash"
}

/** Which shell `installCommand` is written for, to say beside it. */
export function installShell(platform: string): string {
  return platform === "win32" ? "PowerShell" : "Terminal"
}
