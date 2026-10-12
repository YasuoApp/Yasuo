/**
 * Which `claude` this app runs.
 *
 * A bare command name rather than a path, resolved by the login shell, so any
 * of the ways the CLI installs itself — npm, Homebrew, its own installer — is
 * found. `CLAUDE_BIN` is for a custom install.
 *
 * All that is left of an `agent-tools.ts` that also said how each kind of
 * session installed itself and whether it was present: sessions were kinds
 * because the Terminal panel let you pick one, and that panel is gone. What
 * remains runs the agent SDK — a project's chat — and offers no choice.
 */
export function claudeBinary(): string {
  return process.env.CLAUDE_BIN ?? "claude"
}
