# Contributing to Visual Studio Claude

Thanks for looking. This document is the part of the repository that is not
code: how to get it running, the two or three rules that are not negotiable,
and where the seams are if you want to add something.

`AGENTS.md` is the same ground in a paragraph, for a coding agent.
`docs/design.md` is the design document — what each panel is _for_ and
why it behaves the way it does. Read that one before changing how a panel
works; read this one before opening a pull request.

## Getting it running

You need [Bun](https://bun.sh) 1.3+ and Node 20+. One package, no workspaces —
every command is a script at the root.

```bash
bun install
bun run dev      # bundles the main process, starts Vite, launches Electron at it
```

Then, before you push:

```bash
bun run format:check
bun run lint
bun run typecheck
bun run test
```

`bun run test`, not `bun test` — the latter is Bun's own test runner, which
finds nothing here and exits without saying much about it.

CI runs exactly those four, plus `bun run build`, on Linux and macOS. Nothing
in the suite needs Docker, a database, or an agent CLI installed — if a change
makes a test need one of those, the test is testing the wrong thing.

Docker is required at _runtime_ for a project's own Docker-managed databases,
and the Terminal panel's agent sessions need `claude` on your PATH. Neither is
needed to start the app, and each says so in the place it would have been used.

**Changes under `src/main/`, `src/preload/` or `src/shared/` need `bun run dev`
restarted.** Only the renderer hot-reloads. This is the single most common way
to spend twenty minutes on a change that was already working.

## The one rule that matters

The Electron main process (`src/main/`) and the renderer
(`src/renderer/`) **never import each other**. Everything that crosses
between them goes through four places, and adding or changing a call means
touching all four:

1. a method on `DesktopApi` in `src/shared/api.ts` — types only, no
   runtime code
2. a channel name in the `IPC` map at the bottom of that same file
3. a thunk in `src/preload/index.ts`
4. a handler in `src/main/ipc.ts`

Four edits for one call is deliberate. The alternative is two sides that
disagree about what a call returns, discovered at runtime in a packaged build.

The renderer reaches the contract through the `@shared/*` alias; `@/*` is
`src/renderer`.

## Where the seams are

If you are looking for somewhere to start, these are the places designed to be
added to rather than rewritten.

**A new database engine** — `src/renderer/lib/db/engines/`. `types.ts` is the
shape an engine has to produce (`Relation`, `Column`, `SortOrder`, …) and
`postgres.ts` / `mysql.ts` are two full implementations to read against. The
panel is written against the shared types, so it does not learn which engine it
is looking at.

**A new agent CLI** — `src/main/agent-tools.ts`. One record decides both what a
session kind runs and how it installs, and the picker is built from that
record, so it cannot offer something that would not start. Add the kind to
`AgentKind` in `src/shared/api.ts` and the entry to `AGENT_TOOLS`.

**A new panel** — `src/renderer/components/studio/` holds one directory per
panel, with its logic and its zustand store in the matching
`src/renderer/lib/` directory. `components/studio/activity-bar.tsx` is the one
list that decides what is on the rail: add the id to `Section`, an entry to
`SECTIONS`, and a hue to `SECTION_ACCENT`, and the compiler will point at the
two switches in `studio.tsx` that still need a branch.

**A UI component** — take it from shadcn/ui rather than writing it:

```bash
bunx shadcn@latest add dialog
```

It lands in `src/renderer/components/ui/` and is imported as
`@/components/ui/dialog`. Only what something imports is kept there — please
keep it that way rather than adding the whole library up front.

## Tests

Plain `bun` scripts under `test/`, no test framework — see
`test/harness.ts` for the reasoning. `bun run test` discovers every `.ts` in that
directory, so **adding a test is dropping a file in**; there is no list to
update. Run one on its own while you work:

```bash
bun test/transcript.ts
```

The suite prefers real things over fixtures, because the bugs it was written
against were in the seams: `transcript.ts` appends to a real file while the
mirror watches it, and `files.ts` creates, renames and walks real ones rather
than checking against a hand-written sample. If you are testing something that
talks to the outside world, do that.

Not everything needs a test. The suite covers the places where being wrong is
expensive and the feedback would otherwise be slow — a parser, a protocol, a
tail that has to survive a read landing mid-character. A React component that
renders a list is not one of those.

## Style

Prettier decides formatting: no semicolons, double quotes, 80 columns, es5
trailing commas. `bun run format` applies it over the whole repository, and
`bun run format:check` is what CI runs. Don't argue with it in review.

`bun run typecheck` is three TypeScript projects, not one — the main process is
Node, the renderer is a browser, and the tests are Node programs that import
from both. A `process.env` that typechecks in the renderer would be a crash in
a page, so the three are kept apart deliberately.

**Comments explain _why_, not _what_.** Which failure a constant was written
against, why an approach was rejected, what breaks if the order changes. A
comment restating the line below it is noise, and this codebase is fairly
disciplined about that — match the density and tone of what is already around
your change.

Files named `*.local.*` are gitignored scratch. Use that suffix for a repro or
a one-off experiment so it can live next to its subject without being
committed.

## Pull requests

- One change per pull request. A refactor bundled with a fix is two.
- Say what the change is _for_ in the description. The diff already says what
  it does.
- Green CI before review, not after.
- If the change affects how a panel behaves, update `docs/design.md` in
  the same pull request. That document drifting out of date is worse than it
  not existing, because people trust it.

Large or structural changes — a new panel, a new dependency, a change to the
IPC contract's shape — are worth an issue first. Not for permission; for the
chance that someone says "there is a reason it is like that" before you have
written it.

## Reporting a bug

Include your OS and architecture, whether you are running `bun dev` or a
packaged build, and what the console said. For anything touching a database,
the engine and its version. Visual Studio Claude is developed on macOS; Linux and Windows
builds exist but are far less travelled, so platform is rarely irrelevant.

Security issues go to `SECURITY.md` instead — please don't open a public issue
for one.
