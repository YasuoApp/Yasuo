import { useEffect, useState } from "react"

import {
  CHAT_MODEL_FALLBACK,
  DEFAULT_CHAT_EFFORT,
  type AgentModel,
  type ChatEffort,
} from "@shared/api"

/**
 * The models the user's own `claude` offers, for the composer's toolbar.
 *
 * A hook rather than a store because there is nothing to keep: the list is
 * whatever the CLI said, it does not change while the app is running, and
 * nothing writes to it. Main holds the answer for the run (`agent-models.ts`)
 * and this holds it for the window, so the second composer to mount gets it
 * without a round trip and the picker has its labels before it is opened —
 * which is the reason this runs on mount rather than on the menu opening: the
 * toolbar button draws the *name* of the chosen model, and a button that says
 * `opus` until somebody clicks it is a button that was waiting for nothing.
 *
 * The fallback stands in whenever the ask came back with nothing — a `claude`
 * that is not installed yet, or a spawn that timed out — because a picker with
 * no rows is a chat nobody can change the model of. It is deliberately three
 * aliases and not a guess at this machine's list; see `CHAT_MODEL_FALLBACK`.
 */

/** Shared by every composer in the window: the promise, so two mounting at
 * once make one call, and the answer, so a later one makes none. */
let asked: Promise<AgentModel[]> | null = null
let held: AgentModel[] | null = null

/**
 * What the CLI answered, with the preset's own trimmings where a row matches.
 *
 * **The CLI's list is the list**, and the preset is only what stands in when
 * there is no answer at all. It was the other way round — every preset row kept,
 * the answer used only to correct their effort levels — and what that did was
 * put models on the picker that the account does not have: `Sonnet 5 1M` and
 * five other invented aliases were offered on every machine, and picking one
 * failed the turn on its argument list, because `--model sonnet-5-1m` names
 * nothing. Which models exist is a property of the account and the CLI version
 * behind it (see `AgentModel`), so it is not something this file can hold a copy
 * of.
 *
 * A preset row is still read for the two things the CLI does not send — the
 * picker's `order` and its badges — and only where the `value` matches, so it
 * decorates rather than adds.
 */
export function mergeModels(
  preset: AgentModel[],
  discovered: AgentModel[]
): AgentModel[] {
  if (discovered.length === 0) return preset
  const presets = new Map(preset.map((model) => [model.value, model]))
  return discovered.map((model) => {
    const known = presets.get(model.value)
    if (!known) return model
    return {
      ...model,
      ...(known.order !== undefined ? { order: known.order } : {}),
    }
  })
}

export function useAgentModels(): AgentModel[] {
  const [models, setModels] = useState<AgentModel[]>(
    held ?? CHAT_MODEL_FALLBACK
  )

  useEffect(() => {
    if (held) return
    let mounted = true
    asked ??= window.desktop.agentModels()
    void asked
      .then((answer) => {
        const merged = mergeModels(CHAT_MODEL_FALLBACK, answer)
        held = merged
        if (mounted) setModels(merged)
      })
      .catch((error: unknown) => {
        asked = null
        console.error("Could not read the model list", error)
      })
    return () => {
      mounted = false
    }
  }, [])

  return models
}

/**
 * The order the picker draws them in.
 *
 * The CLI answers in an order of its own — `default`, `sonnet`, `fable`,
 * `opus[1m]`, `haiku`, `opus` on the machine this was written on — which reads
 * as a bug in a menu. So `default` keeps the top, because it is the CLI's own
 * recommendation and the row a new chat is on, and the rest go by name. By name
 * rather than by capability on purpose: this app knows nothing about which model
 * is the strongest, and an order implying it would be a ranking somebody trusts.
 */
export function orderedModels(models: AgentModel[]): AgentModel[] {
  return [...models].sort((left, right) => {
    if (left.value === "default") return -1
    if (right.value === "default") return 1
    if (left.order !== undefined && right.order !== undefined) {
      return left.order - right.order
    }
    if (left.order !== undefined) return -1
    if (right.order !== undefined) return 1
    return left.label.localeCompare(right.label)
  })
}

/**
 * What `Default (recommended)` is, in the name of a model somebody recognises.
 *
 * The CLI's `default` row is a recommendation rather than a model: its label
 * names nothing, so a picker that drew it alone put its tick on a word, and the
 * one question the menu exists to answer — which model is answering — had no
 * answer anywhere on screen. `resolvedModel` is the wire id behind a row, so the
 * alias row sharing the default's is the default under a name (`Sonnet`).
 *
 * Null wherever that cannot be said honestly: a CLI old enough not to send the
 * field, and a default whose id no other row carries. Both draw the row as it
 * was, which is the failure this is allowed to have — a missing suffix, not a
 * wrong one. The row itself is deliberately **not** replaced by the alias: they
 * are the same model today and `default` is the one that follows the account.
 */
export function defaultModelAlias(models: AgentModel[]): string | null {
  const fallback = models.find((entry) => entry.value === "default")
  if (!fallback?.resolvedModel) return null
  const named = models.find(
    (entry) =>
      entry.value !== "default" &&
      entry.resolvedModel === fallback.resolvedModel
  )
  return named?.label ?? null
}

/**
 * The level a pick lands on, given the levels the model in question takes.
 *
 * Every pick goes through this rather than through a `Default` row, which is
 * the whole of that change: the record carries a level the toolbar can tick and
 * main can pass, instead of a null that meant "ask the CLI" and read on screen
 * as nothing at all. Keeps the level already chosen where the new model accepts
 * it — switching Sonnet to Opus is not a reason to lose `Very high` — and falls
 * to `DEFAULT_CHAT_EFFORT` otherwise, or to the strongest level below it for a
 * model whose list stops short.
 */
export function effortFor(
  levels: ChatEffort[],
  effort: ChatEffort | null
): ChatEffort | null {
  if (levels.length === 0) return null
  if (effort && levels.includes(effort)) return effort
  if (levels.includes(DEFAULT_CHAT_EFFORT)) return DEFAULT_CHAT_EFFORT
  // The list is weakest first, so the last one is as close as this model gets.
  return levels[levels.length - 1] ?? null
}
