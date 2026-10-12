## What this is for

<!-- The diff says what the change does. Say what it is for: the problem, the
     bug, the thing that was awkward. One or two sentences is plenty. -->

## Notes for the reviewer

<!-- Optional: an approach you rejected, a place you were unsure, a follow-up
     you deliberately left out. -->

## Checklist

- [ ] `bun run format:check`, `bun run lint`, `bun run typecheck` and
      `bun run test` pass locally
- [ ] If this crosses between the main process and the renderer, all four
      places are updated — `shared/api.ts` (the type and the `IPC` entry),
      `src/preload/index.ts`, `src/main/ipc.ts`
- [ ] If this changes how a panel behaves, `docs/design.md` is updated
      in this pull request
- [ ] No `*.local.*` scratch files, and no unrelated formatting churn
