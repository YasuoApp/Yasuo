# vsclaude-cloud

The server behind Visual Studio Claude's **free AI**: anybody signed in to the
studio can chat on Haiku without a Claude account of their own. The studio's
`claude` is pointed here (`ANTHROPIC_BASE_URL`) and sends the user's Firebase ID
token; this server checks it, holds the request to the allowed model and the
user's daily budget, and forwards it to Anthropic with its own API key.

```
studio's claude ──(Firebase ID token)──▶ vsclaude-cloud ──(server API key)──▶ api.anthropic.com
```

The app's half is `src/shared/free-ai.ts` and `src/main/free-ai.ts` in
`visual-studio-claude`, and `docs/design.md` § The free AI there.

## Endpoints

| Route                                | What                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------- |
| `POST /v1/messages`                  | Passed through, streamed; counted against the user's budget.          |
| `POST /v1/messages/count_tokens`     | Passed through; not counted (free at Anthropic).                       |
| `GET /v1/models`                     | The allowed models, in Anthropic's list shape.                         |
| `GET /api/usage`                     | The signed-in user's spend today: `{ spent, budget, utilization, resetsAt }`. |
| `HEAD/GET /api/hello`                | The reachability probe Claude Code sends to a custom base URL.         |

Every route but `/api/hello` needs the token, as `Authorization: Bearer …` or
`x-api-key` (the CLI sends both). Errors are Anthropic's own shape and status,
so the CLI shows them as it would Anthropic's:

- `401 authentication_error` — no token, or not a live ID token of the project.
- `403 permission_error` — a model other than the allowed ones.
- `429 rate_limit_error` + `retry-after` — today's budget is spent.

The user's token is never forwarded; Anthropic sees only this server's key.

## The budget

Per user per UTC day, in **input-token equivalents**: each kind of token is
weighted by its price against an uncached input token — cache writes 1.25×,
cache reads 0.1×, output 5× (`server/utils/usage.ts`). Read off Anthropic's own
`usage` (streamed or not); a request cut off by Stop is still counted for what
was generated. A request running when the budget runs out is finished; the next
one is refused.

Stored under the `quota` mount, `./.data/quota` on the server's disk by default.
That is right for **one instance**. Behind a load balancer, point it at a shared
driver (Redis, Upstash, Cloudflare KV — see `nitro.config.ts`), or every
instance counts its own share of a user's day.

## Configuration

All in `nitro.config.ts` › `runtimeConfig`, overridden by environment variables
(`.env` in development; see `.env.example`):

| Variable                    | Default             | What                                                   |
| --------------------------- | ------------------- | ------------------------------------------------------ |
| `NITRO_ANTHROPIC_API_KEY`   | — (required)        | A Console API key. Every free request spends it.       |
| `NITRO_ALLOWED_MODELS`      | `claude-haiku-5-5`  | Comma-separated. Keep in step with the app's `FREE_AI_MODEL`. |
| `NITRO_DAILY_BUDGET`        | `2000000`           | Per user per day, input-token equivalents. `0` = no limit. |
| `NITRO_FIREBASE_PROJECT_ID` | `simm-chat`         | The project the studio signs in to.                    |
| `NITRO_ANTHROPIC_BASE_URL`  | `https://api.anthropic.com` |                                                |
| `NITRO_FIREBASE_JWKS_URL`   | Google's            | Only for a test that signs its own tokens.             |

## Running

```bash
bun install
cp .env.example .env      # and fill in the API key
bun run dev               # http://localhost:3000
```

Then start the studio against it:

```bash
VSCLAUDE_AI_URL=http://localhost:3000 bun run dev   # in visual-studio-claude
```

(`http://` is accepted by the app for `localhost` only; anywhere else it must be
`https://`, since the user's token goes there on every request.)

```bash
bun run test        # token checks, model check, usage counting
bun run typecheck
bun run build       # .output/server/index.mjs — `node .output/server/index.mjs`
```

Deploy with any [Nitro preset](https://nitro.build/deploy). The response streams,
so the platform must not buffer responses, and its request timeout has to
outlast a long turn (several minutes).

## Not done yet

- **Abuse beyond the budget.** One Google account is one budget; nothing stops
  somebody making many. Consider requiring a verified email, rate-limiting new
  accounts, or Firebase App Check.
- **A ceiling on the whole service.** Set a monthly spend limit on the Anthropic
  key itself in the Console — that is the hard stop.
- **Usage in the studio.** `GET /api/usage` is there; the app does not draw it
  yet.
