import { defineHandler } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { listOf } from "../../utils/anthropic.ts"
import { authenticate } from "../../utils/auth.ts"

/**
 * `GET /v1/models` — the models this server serves, in Anthropic's list shape,
 * answered here rather than passed through: Anthropic's list is every model the
 * server's key can reach, and offering those would be offering refusals.
 */
export default defineHandler(async (event) => {
  const user = await authenticate(event)
  if (user instanceof Response) return user

  const data = listOf(useRuntimeConfig().allowedModels).map((id) => ({
    type: "model",
    id,
    display_name: id,
    created_at: "1970-01-01T00:00:00Z",
  }))
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  }
})
