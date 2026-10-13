import type { ClaudeAccount, ClaudeVersions } from "../src/shared/api"
import {
  installCommand,
  setupStep,
} from "../src/renderer/lib/worktree-chat/claude-setup"
import { check, finish, section } from "./harness"

/**
 * Which step the launch's setup screen shows. Tested because the screen stands
 * between somebody and the app: a wrong `install` or `signIn` here is a gate in
 * front of a machine that could have chatted all along.
 */

const found: ClaudeVersions = { cli: "2.1.3", sdk: "0.2.0", error: null }
const missing: ClaudeVersions = {
  cli: null,
  sdk: "0.2.0",
  error: "Could not find `claude` on your PATH.",
}

function account(state: ClaudeAccount["state"]): ClaudeAccount {
  return {
    configDir: "",
    state,
    email: null,
    organization: null,
    method: null,
    plan: null,
    error: null,
  }
}

section("setupStep")

check(
  "nothing asked yet is checking",
  setupStep({ versions: undefined, account: undefined, hasProfiles: false }) ===
    "checking"
)
check(
  "no claude asks for an install without waiting on the login",
  setupStep({ versions: missing, account: undefined, hasProfiles: false }) ===
    "install"
)
check(
  "a claude whose login is still being asked is checking",
  setupStep({ versions: found, account: undefined, hasProfiles: false }) ===
    "checking"
)
check(
  "signed out asks for a login",
  setupStep({
    versions: found,
    account: account("signedOut"),
    hasProfiles: false,
  }) === "signIn"
)
check(
  "signed out with profiles is ready — the default login may be unused",
  setupStep({
    versions: found,
    account: account("signedOut"),
    hasProfiles: true,
  }) === "ready"
)
check(
  "a status that could not be read is ready, not a gate",
  setupStep({
    versions: found,
    account: account("error"),
    hasProfiles: false,
  }) === "ready"
)
check(
  "signed in is ready",
  setupStep({
    versions: found,
    account: account("signedIn"),
    hasProfiles: false,
  }) === "ready"
)

section("installCommand")

check("Windows gets PowerShell's", installCommand("win32").startsWith("irm "))
check("macOS gets the shell's", installCommand("darwin").startsWith("curl "))
check("Linux gets the shell's", installCommand("linux").startsWith("curl "))

finish()
