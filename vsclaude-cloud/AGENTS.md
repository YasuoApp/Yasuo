This project is based on [Nitro v3](https://nitro.build), [h3](https://h3.dev/), and [Rolldown](https://rolldown.rs/).

Refer to `node_modules/nitro/dist/docs/README.md` when working on server (your knowledge about Nitro v3 is likely outdated!).

## Project Structure

`server/` contains server-side code with supported subdirs (create as needed): `api/` (/api prefixed handlers), `routes/` (non-prefixed route handlers), `middleware/`, `plugins/`, `utils/`, `assets/`, and `tasks/`. `public/` holds static assets (copied, not bundled). Config files: `nitro.config.ts` (serverDir, routeRules, preset, etc.), `tsconfig.json`.

## Conventions

- Relative imports with explicit `.ts` extensions (`../utils/auth.ts`). **Not
  the `~/*` alias in `server/`**: tsconfig knows it but the Nitro build does
  not resolve it — it is left as an external import, which crashes under Node
  and, under Bun, loads the source file outside the bundle with a stub
  `useRuntimeConfig` that ignores every `NITRO_*` variable.
- `bun run test` (Bun's runner, `test/`), `bun run typecheck`.

## What this server is

The free AI behind Visual Studio Claude — see `README.md`. Signed-in studio
users (Firebase ID tokens) get `POST /v1/messages` passed through to Anthropic
on the allowed model, within a daily budget per user.
