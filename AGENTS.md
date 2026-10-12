# Working in this repo

**Visual Studio Claude** — an Electron studio that puts a project's databases, HTTP
endpoints, specs, terminals and agent sessions behind one tab strip rather than
one application each. One package, no workspaces: `src/main/` is the Electron
main process, `src/preload/` the bridge script, `src/renderer/` the React app,
`src/shared/` the contract between them.

- `bun install`, then `bun run dev`, `bun run build`, `bun run lint`,
  `bun run typecheck`, `bun run test` — `bun run test`, not `bun test`, which
  is Bun's own runner and finds nothing here. It discovers every file under
  `test/`, so a new test needs no list updating.
- `bun run typecheck` is three TypeScript projects, one per environment:
  `tsconfig.main.json` (Node), `tsconfig.renderer.json` (DOM) and
  `tsconfig.test.json`, the only one that sees both.
- The Electron main process and the renderer never import each other.
  Everything that crosses between them is a type in `src/shared/api.ts` plus a
  channel name in the `IPC` map at the bottom of it. Add to both, then to
  `src/preload/index.ts` and `src/main/ipc.ts`, or the two sides drift.
- UI components come from `@/components/ui/*`. Add new ones with
  `bunx shadcn@latest add <name>` rather than by hand.
- Files named `*.local.*` are gitignored scratch — use that suffix for repros
  and one-off experiments instead of leaving them untracked or committing them.

Comments here explain _why_, not what. Match that: the existing code says what
a constant is for and which failure it was written against, and a new comment
that only restates the line below it is noise.
