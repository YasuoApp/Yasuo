import { execFile } from "node:child_process"

import {
  chatOptions,
  type WorktreeChatEvent,
  type WorktreeChatOptions,
} from "../shared/api"
import { shell, spawnEnvironment } from "./shell-env"
import type { WorktreeChats } from "./worktree-chat"
import { WorkflowStopped, type Steps } from "./workflow-runner"

/**
 * What a workflow's steps actually do, for `runWorkflow` to call.
 *
 * Free of `electron` so `ipc.ts` can import it under the browser build; the
 * one thing a step needs from the app is the chats, handed in.
 */

/** How long a shell step or a request may take. Generous because a step may
 * be a test suite or a deploy; not unbounded because a hung step is a run
 * that never ends and a Stop button that does nothing. */
const STEP_TIMEOUT_MS = 10 * 60 * 1000

/** Enough for a build log; past it the step fails rather than the process
 * growing without bound. */
const MAX_OUTPUT = 8 * 1024 * 1024

/**
 * The chat events, forked to whichever workflow step is waiting on a chat.
 *
 * `WorktreeChats` emits to one listener — the one `ipc.ts` gives it, which
 * sends every event to the windows. A Claude step needs the same stream for
 * one chat: the text that comes back and the `done` that ends the turn. So
 * `ipc.ts` hands every event here as well, and a step subscribes by chat id
 * for exactly as long as its turn runs.
 */
export class ChatTap {
  private readonly listeners = new Map<
    string,
    Set<(event: WorktreeChatEvent) => void>
  >()

  emit(event: WorktreeChatEvent): void {
    for (const listener of this.listeners.get(event.chatId) ?? []) {
      listener(event)
    }
  }

  on(chatId: string, listener: (event: WorktreeChatEvent) => void): () => void {
    let set = this.listeners.get(chatId)
    if (!set) {
      set = new Set()
      this.listeners.set(chatId, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(chatId)
    }
  }
}

/**
 * The steps, bound to **one run** and the chat it was called from.
 *
 * `cwd` is that chat's project: a shell step runs there, and so does every
 * Claude turn, since it is the chat's own. A run whose chat has nowhere to
 * run never reaches here — `ipc.ts` refuses it with a sentence.
 *
 * A Claude box's own permission and model are applied to the chat for its
 * turn, the way the composer's toolbar applies them, and `restore` puts back
 * what the chat had when the run began — the chat is somebody's
 * conversation, and a workflow that left it in `Full access` would be a
 * setting nobody chose.
 */
export function stepsIn(
  chats: WorktreeChats,
  tap: ChatTap,
  chatId: string,
  cwd: string,
  /** The chat's own options when the run was called. */
  base: WorktreeChatOptions
): Steps & { restore: () => Promise<void> } {
  /** What this run last set, so `restore` can tell its own setting from one
   * somebody made in the toolbar meanwhile, and leave theirs alone. */
  let applied: WorktreeChatOptions | null = null

  return {
    claude: async (node, prompt, signal, onChat) => {
      if (signal.aborted) throw new WorkflowStopped()
      const options: WorktreeChatOptions = {
        ...base,
        permission: node.permission ?? base.permission,
        model: node.model?.trim() || base.model,
      }
      if (
        options.permission !== (applied ?? base).permission ||
        options.model !== (applied ?? base).model
      ) {
        await chats.setOptions(chatId, options)
        applied = options
      }
      onChat(chatId)
      return claudeStep(chats, tap, chatId, prompt, node.label, signal)
    },
    shell: (command, signal) => shellStep(command, cwd, signal),
    http: httpStep,
    finished: async (node, summary, entry) => {
      if (
        node.kind !== "shell" &&
        node.kind !== "http" &&
        node.kind !== "condition"
      )
        return null
      const output = entry.status === "failed" ? entry.error : entry.output
      await chats.note(chatId, {
        role: "step",
        kind: node.kind,
        label: node.label,
        summary,
        status: entry.status === "failed" ? "failed" : "done",
        ...(output ? { output } : {}),
      })
      return chatId
    },
    restore: async () => {
      if (!applied) return
      const current = (await chats.list()).find((chat) => chat.id === chatId)
      const now = chatOptions(current?.options)
      if (now.permission === applied.permission && now.model === applied.model)
        await chats.setOptions(chatId, {
          ...now,
          permission: base.permission,
          model: base.model,
        })
    },
  }
}

/**
 * One Claude turn, in the chat the workflow was called from. The step's
 * output is the turn's text, every message joined.
 *
 * Every Claude box of a run sends into that same chat, so the second sees
 * what the first did — "now push it" means something after "fix the tests"
 * — and so does whatever the chat said before the workflow was called.
 *
 * The turn may **stop and ask** — `permission: "ask"` asks about every tool.
 * Nothing here answers for it: the card is in the chat, the run waits with
 * the turn, and whoever is reading the chat decides. Stop ends the turn
 * through the chat's own `stop`, the same `interrupt()` the composer's button
 * sends.
 */
async function claudeStep(
  chats: WorktreeChats,
  tap: ChatTap,
  chatId: string,
  prompt: string,
  step: string,
  signal: AbortSignal
): Promise<{ chatId: string; output: string }> {
  if (signal.aborted) throw new WorkflowStopped()
  const chat = { id: chatId }

  const texts: string[] = []
  const turn = new Promise<string | null>((resolve) => {
    const off = tap.on(chat.id, (event) => {
      if (event.type === "text") texts.push(event.text)
      if (event.type === "done") {
        off()
        resolve(event.error)
      }
    })
    signal.addEventListener(
      "abort",
      () => {
        off()
        chats.stop(chat.id)
        resolve("stopped")
      },
      { once: true }
    )
  })

  // Named for the box on the line itself, so the pane can fold the prompt
  // away and show the answer — the prompt is already on the canvas.
  await chats.send(chat.id, prompt, [], step)
  const error = await turn
  if (signal.aborted) throw new WorkflowStopped()
  if (error) throw new Error(error)
  return { chatId: chat.id, output: texts.join("\n\n").trim() }
}

/**
 * The command, run by the user's own login shell in the project — the same
 * `-l -i` the dock's shells get, so `git`, `node` and whatever `.zshrc`
 * put on PATH are found. Output is stdout and stderr together, in the order
 * they came, which is what the terminal would have shown.
 */
function shellStep(
  command: string,
  cwd: string,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WorkflowStopped())
      return
    }
    void spawnEnvironment().then((env) => {
      const { file, args } = shell(command)
      const chunks: string[] = []
      const child = execFile(
        file,
        args,
        {
          cwd,
          env,
          timeout: STEP_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT,
          windowsHide: true,
          signal,
        },
        (error) => {
          const output = chunks.join("").trim()
          if (signal.aborted) {
            reject(new WorkflowStopped())
            return
          }
          if (error) {
            const code =
              "code" in error && typeof error.code === "number"
                ? ` (exit ${error.code})`
                : ""
            reject(
              new Error(
                output
                  ? `${output}\n${error.message}${code}`
                  : error.message + code
              )
            )
            return
          }
          resolve(output)
        }
      )
      child.stdout?.on("data", (chunk: Buffer | string) =>
        chunks.push(String(chunk))
      )
      child.stderr?.on("data", (chunk: Buffer | string) =>
        chunks.push(String(chunk))
      )
    })
  })
}

/** `Name: value` lines, as a headers record. A line with no colon is
 * ignored rather than refused — it is usually a blank one. */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return headers
}

/**
 * The request, with Node's own `fetch`. The output is the response body as
 * text; a status outside 2xx is a failed step carrying the status and the
 * body, since the body is where an API says what was wrong.
 */
async function httpStep(
  request: { method: string; url: string; headers: string; body: string },
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) throw new WorkflowStopped()
  const timeout = AbortSignal.timeout(STEP_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  const noBody = request.method === "GET" || request.method === "HEAD"

  let response: Response
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: parseHeaders(request.headers),
      body: noBody || !request.body ? undefined : request.body,
      signal: combined,
    })
  } catch (error) {
    if (signal.aborted) throw new WorkflowStopped()
    if (timeout.aborted) throw new Error("The request timed out.")
    throw error instanceof Error ? error : new Error(String(error))
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}${text ? `\n${text.slice(0, 2000)}` : ""}`
    )
  }
  return text
}
