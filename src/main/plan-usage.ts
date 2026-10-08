import { homedir } from "node:os"

import { query } from "@anthropic-ai/claude-agent-sdk"

import type { PlanUsage, PlanWindow } from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

/**
 * How much of the claude.ai plan's rate limits an account has used — the
 * numbers `/usage` in the CLI draws: the five-hour window, the seven-day one,
 * and whichever per-model windows the plan has.
 *
 * **Asked, the way the MCP listing is** (`mcp-servers.ts`): a `claude` process
 * and no tokens, a prompt that never yields, one control request, closed. The
 * CLI is what holds the account's OAuth token and knows which endpoint to ask,
 * so it is asked rather than imitated.
 *
 * **Per account**, by `CLAUDE_CONFIG_DIR`: a chat on a profile is spending that
 * profile's plan, so the meter beside its composer has to be that plan's.
 *
 * **Held for a minute** per account. A composer is mounted for every chat
 * somebody switches to, and a process per switch to read a number that moves by
 * a percent per turn would be most of what this app spawns. `fresh` skips the
 * hold — the popover's Refresh, and the ask after a turn ends, which is the
 * moment the number has actually moved.
 *
 * The control request is the SDK's `usage_EXPERIMENTAL_…`, named that way by
 * the SDK because the shape may change. So everything off it is narrowed
 * (`readPlanUsage`) and a missing method is an answer — "this `claude` does not
 * report it" — rather than a throw.
 */

const HOLD_MS = 60_000

/** A spawn that never answers must not leave the meter asking for ever. */
const TIMEOUT_MS = 20_000

const held = new Map<string, PlanUsage>()
const asking = new Map<string, Promise<PlanUsage>>()

export function planUsage(
  configDir: string | null,
  fresh = false
): Promise<PlanUsage> {
  const key = configDir ?? ""
  const kept = held.get(key)
  if (!fresh && kept && Date.now() - Date.parse(kept.at) < HOLD_MS) {
    return Promise.resolve(kept)
  }
  const inflight = asking.get(key)
  if (inflight) return inflight

  const ask = askCli(configDir)
    .catch((error: unknown): PlanUsage => ({
      ...EMPTY,
      at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((answer) => {
      // A failure is not held: the next look should try again rather than
      // read back a minute of "could not be run".
      if (answer.error === null) held.set(key, answer)
      return answer
    })
    .finally(() => {
      asking.delete(key)
    })

  asking.set(key, ask)
  return ask
}

const EMPTY: Omit<PlanUsage, "at"> = {
  available: false,
  subscription: null,
  windows: [],
  error: null,
}

const USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"

async function askCli(configDir: string | null): Promise<PlanUsage> {
  const binary = await locate(claudeBinary())
  if (!binary) {
    throw new Error(
      `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`
    )
  }

  const stop = new AbortController()
  // A prompt that never arrives — see `mcp-servers.ts`. A prompt that ended
  // would let the process exit before the control request was answered.
  const nothing: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never, undefined>>((resolve) => {
          stop.signal.addEventListener(
            "abort",
            () => resolve({ done: true, value: undefined }),
            { once: true }
          )
        }),
    }),
  }

  const conversation = query({
    prompt: nothing,
    options: {
      cwd: homedir(),
      pathToClaudeCodeExecutable: binary,
      env: await spawnEnvironment(
        configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}
      ),
      abortController: stop,
    },
  })

  try {
    const ask = (conversation as unknown as Record<string, unknown>)[
      USAGE_METHOD
    ]
    if (typeof ask !== "function") {
      return {
        ...EMPTY,
        at: new Date().toISOString(),
        error: "This version of the Claude SDK does not report plan usage.",
      }
    }
    const raw: unknown = await Promise.race([
      (ask as () => Promise<unknown>).call(conversation),
      timeout(),
    ])
    return readPlanUsage(raw, new Date())
  } finally {
    stop.abort()
    await conversation.return?.(undefined).catch(() => {})
  }
}

/**
 * The CLI's answer, narrowed to what the meter draws.
 *
 * Exported for `test/plan-usage.ts`. Every window the answer carries is kept,
 * not only the two the SDK's type names today — the plan's per-model windows
 * arrive under keys of their own, and a key this build has never heard of is
 * still a percentage somebody is spending against. A window with no
 * utilization is dropped: it is a limit the plan does not have.
 */
export function readPlanUsage(raw: unknown, now: Date): PlanUsage {
  const at = now.toISOString()
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY, at, error: "Claude answered with nothing readable." }
  }
  const answer = raw as Record<string, unknown>
  const subscription =
    typeof answer.subscription_type === "string"
      ? answer.subscription_type
      : null

  const limits = answer.rate_limits
  if (answer.rate_limits_available !== true || !limits) {
    return { ...EMPTY, at, subscription }
  }

  const windows: PlanWindow[] = []
  for (const [id, value] of Object.entries(limits as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue
    const entry = value as Record<string, unknown>
    if (typeof entry.utilization !== "number") continue
    windows.push({
      id,
      utilization: Math.max(0, Math.min(100, entry.utilization)),
      resetsAt:
        typeof entry.resets_at === "string" &&
        !Number.isNaN(Date.parse(entry.resets_at))
          ? entry.resets_at
          : null,
    })
  }

  return { available: true, subscription, windows, error: null, at }
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () =>
        reject(
          new Error(`\`claude\` did not answer in ${TIMEOUT_MS / 1000}s.`)
        ),
      TIMEOUT_MS
    ).unref()
  })
}
