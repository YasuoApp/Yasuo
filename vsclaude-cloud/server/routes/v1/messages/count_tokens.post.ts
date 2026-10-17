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

/**
 * `POST /v1/messages/count_tokens` — how big a prompt is, which the CLI asks
 * before compacting. Free at Anthropic, so it is not held against the budget,
 * but it is still a signed-in user's and still the allowed model's.
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

  const url = new URL(event.url.pathname + event.url.search, config.anthropicBaseUrl)
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: upstreamHeaders(event.req.headers, config.anthropicApiKey),
      body: text,
      signal: event.req.signal,
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: downstreamHeaders(upstream.headers),
    })
  } catch (error) {
    console.error("Anthropic could not be reached", error)
    return anthropicError(502, "api_error", "Anthropic could not be reached.")
  }
})
