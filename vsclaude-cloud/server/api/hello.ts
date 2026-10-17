import { defineHandler } from "nitro"

/**
 * `/api/hello` — the probe Claude Code sends to a custom `ANTHROPIC_BASE_URL`
 * before its first request (a `HEAD`, seen against a local server). Answered
 * so it finds the server there; it carries nothing and needs no sign-in.
 */
export default defineHandler(() => ({ ok: true }))
