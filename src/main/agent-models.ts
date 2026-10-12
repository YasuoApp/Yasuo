import { query } from "@anthropic-ai/claude-agent-sdk"

import { CHAT_EFFORTS, type AgentModel, type ChatEffort } from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

/**
 * Which models the user's own `claude` will answer on.
 *
 * **Why this is asked rather than written down.** The composer's picker was a
 * list of four aliases in `@shared/api`, and the problem with a written list is
 * not that it goes stale: which models an install offers is a property of the
 * account and the CLI version behind it, so one machine's list carries
 * `Opus (1M context)` and a Fable that wants credits while another's has
 * neither. A picker offering a model the account cannot use is a turn that
 * fails after somebody has typed a message, and one hiding a model they are
 * paying for is worse.
 *
 * **What it costs.** A `claude` process and no tokens. `supportedModels()` is a
 * control request over the SDK's own stdin channel — the same channel
 * `canUseTool` answers on — so it is answered by the CLI out of what it knows
 * about the account, without an API call. The prompt handed to `query()` is an
 * async iterable that never yields, which is what keeps it that way: the
 * process comes up, initialises, answers, and is closed. The control request
 * itself is ~500ms; the whole call is ~2.7s cold, almost all of it the login
 * shell being asked where `claude` is, which is what the timeout is sized for.
 *
 * **Held for the run.** A picker opening is not a reason to spawn a process, and
 * the answer only changes when the user installs a different CLI or their plan
 * changes — neither of which happens between two openings of a menu. The
 * in-flight promise is what is cached rather than the result, so two windows
 * opening their pickers at once share the one process; a failure is not cached
 * at all, so a CLI that was missing when the app launched is found once it is
 * installed.
 */

/** The one in-flight or finished ask. Cleared on failure — see above. */
let asking: Promise<AgentModel[]> | null = null

/**
 * A spawn that never answers must not leave a picker waiting.
 *
 * Long enough for a login shell to be asked where `claude` is and for the CLI
 * to come up on a cold cache, short enough that a picker falls back to the
 * aliases while somebody is still looking at it.
 */
const TIMEOUT_MS = 10_000

export function agentModels(): Promise<AgentModel[]> {
  asking ??= ask().catch((error: unknown) => {
    // Not cached: the next picker to open tries again. Worth a line in the log
    // because the fallback list is silent otherwise — a user seeing three
    // aliases where they expected their own six has nothing else to go on.
    console.error("Could not ask claude which models it has", error)
    asking = null
    return []
  })
  return asking
}

async function ask(): Promise<AgentModel[]> {
  // The same resolve every other `claude` in this app goes through: a GUI app
  // inherits almost none of the user's PATH.
  const binary = await locate(claudeBinary())
  if (!binary) return []

  const held = new AbortController()

  /*
   * A prompt that never arrives.
   *
   * `query()` starts the CLI on the first read of this, and a prompt that
   * *ended* would let the process exit before the control request had been
   * answered — so the one read it gets never settles until the abort below.
   * Written as an iterable rather than an `async function*` because a generator
   * with no `yield` in it is a generator only by accident: this is a stream that
   * has nothing in it by design, and saying so in the type is better than
   * silencing the lint rule that noticed.
   */
  const nothing: AsyncIterable<never> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<never, undefined>>((resolve) => {
          held.signal.addEventListener(
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
      pathToClaudeCodeExecutable: binary,
      env: await spawnEnvironment(),
      abortController: held,
    },
  })

  try {
    const models = await Promise.race([
      conversation.supportedModels(),
      timeout(),
    ])
    return models.map(readModel)
  } finally {
    // Both, in this order: the abort is what the never-arriving prompt above is
    // waiting on, and `return()` is what tears the transport down.
    held.abort()
    await conversation.return?.(undefined).catch(() => {})
  }
}

function timeout(): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`No answer in ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS
    ).unref()
  })
}

/**
 * One row of the CLI's answer, narrowed to what a picker draws.
 *
 * The effort levels are filtered against `CHAT_EFFORTS` rather than trusted:
 * they cross into the renderer as a `ChatEffort`, and a CLI that grows a sixth
 * level would otherwise put a word in the picker that this app has no icon or
 * label for. `supportsEffort` false and an empty list mean the same thing here —
 * a picker with nothing to offer — which is why only the list is kept.
 */
export function readModel(model: {
  value: string
  resolvedModel?: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}): AgentModel {
  const levels = model.supportsEffort ? (model.supportedEffortLevels ?? []) : []
  const isNew =
    /\b(?:opus\s*5|sonnet\s*5|new)\b/i.test(model.displayName) ||
    /\b(?:opus\s*5|sonnet\s*5)\b/i.test(model.description)
  // The star is the row to pick, so it names the current flagship and moves
  // when one lands — Opus 5.5 took it from 4.8. A version and not an alias:
  // `opus` follows the account, and starring it would star whatever that
  // resolves to on a machine whose CLI predates the release.
  const isFavorite =
    /\b(?:5\.5|recommended)\b/i.test(model.displayName) ||
    model.value === "default"
  return {
    value: model.value,
    // Omitted rather than carried as undefined, so a row from a CLI that
    // predates the field and one that resolves to nothing are the same record.
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    label: model.displayName,
    description: model.description,
    efforts: levels.filter((level): level is ChatEffort =>
      (CHAT_EFFORTS as readonly string[]).includes(level)
    ),
    ...(isNew ? { isNew: true } : {}),
    ...(isFavorite ? { isFavorite: true } : {}),
  }
}
