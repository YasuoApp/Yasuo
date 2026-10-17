import { defineHandler } from "nitro"
import { useRuntimeConfig } from "nitro/runtime-config"

import { authenticate } from "../utils/auth.ts"
import { secondsToReset, spentToday } from "../utils/quota.ts"

/**
 * `GET /api/usage` — how much of today's free budget the signed-in user has
 * spent, for a meter in the studio. Same token as the chat requests.
 */
export default defineHandler(async (event) => {
  const user = await authenticate(event)
  if (user instanceof Response) return user

  const budget = Number(useRuntimeConfig().dailyBudget)
  const spent = await spentToday(user.uid)
  return {
    spent,
    budget,
    // A percentage the studio can draw without knowing the unit.
    utilization: budget > 0 ? Math.min(100, (spent / budget) * 100) : 0,
    resetsAt: new Date(Date.now() + secondsToReset() * 1000).toISOString(),
  }
})
