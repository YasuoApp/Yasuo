# Security

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainer.

Include what you did, what happened, and what you expected — and, if you have
one, the smallest project or database that reproduces it. You can expect an
acknowledgement within a few days. This is a small project maintained in spare
time; please say so in your report if you have a disclosure deadline in mind,
so it can be planned around rather than missed.

## What Visual Studio Claude is, in security terms

Visual Studio Claude is a desktop developer tool. It is not multi-tenant, it has no server
side, and it has no accounts. Everything below is about a single user's own
machine, and that framing is what most of the design decisions follow from.

**Database credentials.** Passwords are encrypted with Electron's
`safeStorage`, which is backed by the OS keystore — Keychain on macOS, DPAPI on
Windows, libsecret on Linux — and stored in the manifest under `~/.vsclaude`.
They are stripped field by field before any database record crosses to the
renderer, so a password never reaches the page. See `src/main/encryption.ts`
and `src/main/store.ts`.

Note the limit of this: `safeStorage` protects the manifest against another
_user_ on the machine, not against code running as you. Anything you can run,
Visual Studio Claude can run.

**The pty daemon.** Terminal sessions run in a detached per-machine daemon
spoken to over a Unix socket (a named pipe on Windows). Anything that can open
that socket can start a process as you.

**HTTP requests.** The API panel sends requests from the main process, so there
is no page origin and no CORS preflight, and forbidden headers go out as typed.
That is deliberate — it is an HTTP client, and an HTTP client that could not
set `Host` would be a worse one. The cookie jar in `cookies.json` is the
panel's own, not Chromium's.

**Agent output is untrusted.** The AI features shell out to `claude -p` and
treat what comes back as input, not instruction: every proposed filter
condition is checked against the columns and operators that actually exist, so
a hallucinated column yields one fewer condition rather than a broken clause.
Hold new AI features to that — a model's output must not become a query, a
path, or a command without passing through something that knows what is valid.

## Out of scope

- Anything requiring an attacker to already run code as your user.
- The contents of a project you opened. Visual Studio Claude reads and runs what you point it
  at, the same as an editor or a shell.
- Unsigned builds. `make dmg` produces an unsigned artifact unless `SIGN=1`;
  that is a packaging default, not a defect.
