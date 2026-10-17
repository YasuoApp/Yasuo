import { defineHandler } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import {
  allowedModel,
  anthropicError,
  downstreamHeaders,
  listOf,
  upstreamHeaders,
} from "../../../utils/anthropic.ts"
import { authenticate } from "../../../utils/auth.ts"
import { addSpend, secondsToReset, spentToday } from "../../../utils/quota.ts"
import { StreamUsage, usageOf, weighted } from "../../../utils/usage.ts"

/**
 * `POST /v1/messages` — the one call a chat makes, passed through to Anthropic
 * for a signed-in user, on an allowed model, within the day's budget.
 *
 * The body goes on **as the bytes that arrived**: it is parsed only to read the
 * model, and re-serialising it could reorder what the CLI wrote and spoil the
 * prompt cache's prefix match. The answer comes back the same way, streamed
 * chunk for chunk, with a reader alongside that keeps the usage.
 */
export default defineHandler(async (event) => {
  const config = useRuntimeConfig()
  if (!config.anthropicApiKey) {
    return anthropicError(500, "api_error", "The server has no Anthropic key.")
  }

  const user = await authenticate(event)
  if (user instanceof Response) return user

  const text = await event.req.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return anthropicError(400, "invalid_request_error", "The body is not JSON.")
  }

  const models = listOf(config.allowedModels)
  if (!allowedModel(body, models)) {
    return anthropicError(
      403,
      "permission_error",
      `The free AI runs ${models.join(", ")} only.`
    )
  }

  const budget = Number(config.dailyBudget)
  if (budget > 0 && (await spentToday(user.uid)) >= budget) {
    return anthropicError(
      429,
      "rate_limit_error",
      "You have used today's free AI. It resets at 00:00 UTC.",
      { "retry-after": String(secondsToReset()) }
    )
  }

  const url = new URL(event.url.pathname + event.url.search, config.anthropicBaseUrl)
  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(event.req.headers, config.anthropicApiKey),
      body: text,
      // A chat the user stopped is a request Anthropic should stop generating.
      signal: event.req.signal,
    })
  } catch (error) {
    if (event.req.signal.aborted) return new Response(null, { status: 499 })
    console.error("Anthropic could not be reached", error)
    return anthropicError(502, "api_error", "Anthropic could not be reached.")
  }

  const headers = downstreamHeaders(upstream.headers)
  const streamed = upstream.headers
    .get("content-type")
    ?.includes("text/event-stream")

  if (!upstream.body || !upstream.ok || !streamed) {
    // Errors and non-streamed answers are small: read whole, counted from the
    // JSON's own `usage` when there is one, and passed on unchanged.
    const answer = await upstream.text()
    if (upstream.ok) {
      try {
        const parsed = JSON.parse(answer) as { usage?: unknown }
        await addSpend(user.uid, weighted(usageOf(parsed.usage)))
      } catch {
        // Not JSON: nothing to count, and the client is owed it anyway.
      }
    }
    return new Response(answer, { status: upstream.status, headers })
  }

  const meter = new StreamUsage()
  const reader = upstream.body.getReader()
  let recorded = false
  // Once, however the stream ends — finished, failed, or cut off by a Stop:
  // tokens Anthropic generated before the Stop were still paid for.
  const record = () => {
    if (recorded) return
    recorded = true
    void addSpend(user.uid, weighted(meter.usage)).catch((error: unknown) =>
      console.error("Could not record usage", error)
    )
  }

  const counted = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          record()
          controller.close()
          return
        }
        meter.push(value)
        controller.enqueue(value)
      } catch (error) {
        record()
        controller.error(error)
      }
    },
    cancel(reason) {
      record()
      return reader.cancel(reason)
    },
  })

  return new Response(counted, { status: upstream.status, headers })
})
