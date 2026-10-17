/**
 * Talking to Anthropic on the user's behalf, and answering the CLI in
 * Anthropic's own shapes.
 *
 * Errors go back as Anthropic's error body (`{ type: "error", error: { type,
 * message } }`) with Anthropic's status codes, because the client is Claude
 * Code: it reads those, shows the message, and decides on its own whether to
 * retry — a 429 it backs off from, a 403 it does not.
 */

export function anthropicError(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ type: "error", error: { type, message } }),
    { status, headers: { "content-type": "application/json", ...headers } }
  )
}

/**
 * The model a request asked for, if it is one this server serves.
 *
 * Exact ids only: the CLI resolves its aliases before sending, and the studio
 * pins every alias to the one model (`freeAiEnv` there), so anything else
 * arriving here is somebody calling the server by hand.
 */
export function allowedModel(body: unknown, allowed: string[]): string | null {
  if (!body || typeof body !== "object") return null
  const model = (body as Record<string, unknown>).model
  return typeof model === "string" && allowed.includes(model) ? model : null
}

/** The request headers Anthropic is sent: the protocol's own, never the
 * client's credentials — those were for this server. */
export function upstreamHeaders(from: Headers, apiKey: string): Headers {
  const headers = new Headers({
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": from.get("anthropic-version") ?? "2023-06-01",
  })
  const beta = from.get("anthropic-beta")
  if (beta) headers.set("anthropic-beta", beta)
  const accept = from.get("accept")
  if (accept) headers.set("accept", accept)
  return headers
}

/** The response headers the CLI is passed back: what it reads to decide on a
 * retry and to name a request in a bug report. */
export function downstreamHeaders(from: Headers): Headers {
  const headers = new Headers()
  for (const name of [
    "content-type",
    "request-id",
    "retry-after",
    "x-should-retry",
  ]) {
    const value = from.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** The comma-separated list a runtime config holds, as ids. */
export function listOf(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
}
