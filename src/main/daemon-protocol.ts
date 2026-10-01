/**
 * The wire protocol between the daemon (`daemon.ts`, owns the ptys) and the
 * main process's client (`daemon-client.ts`) — newline-delimited JSON, one
 * object per line, both directions. Its own file so the two sides of the
 * socket cannot describe the same message shape two different ways.
 */

import { homedir } from "node:os"
import path from "node:path"

/** Where both sides find each other. A named pipe has no filesystem path to
 * agree on on Windows, so it is not "under `~/.yasuo`" there — just a
 * name both processes know. */
export function socketPath(): string {
  const name = `agent-daemon-v${PROTOCOL_VERSION}`
  if (process.platform === "win32") return `\\\\.\\pipe\\yasuo-${name}`
  return path.join(homedir(), ".yasuo", `${name}.sock`)
}

/**
 * Bumped whenever a message changes shape, and part of the socket's name.
 *
 * The daemon is per machine and outlives any one app: an installed build with
 * a shell open keeps its daemon alive indefinitely, so a newer build on the
 * same socket was talking to the older daemon — `created` arrived without the
 * `pid` the dock's tab names are read off, and nothing said why. A socket per
 * version gives each build the daemon it was compiled against.
 */
const PROTOCOL_VERSION = 2

export type CreateRequest = {
  op: "create"
  reqId: string
  cwd: string
  command?: string
  env?: Record<string, string>
  cols: number
  rows: number
}
export type AttachRequest = { op: "attach"; reqId: string; id: string }
export type WriteRequest = { op: "write"; id: string; data: string }
export type ResizeRequest = {
  op: "resize"
  id: string
  cols: number
  rows: number
}
export type KillRequest = { op: "kill"; id: string }

export type DaemonRequest =
  CreateRequest | AttachRequest | WriteRequest | ResizeRequest | KillRequest

export type CreatedResponse = {
  type: "created"
  reqId: string
  id: string
  /** The shell's own pid, for asking where it has `cd`'d to. Optional because
   * a daemon left running by an older build does not send it. */
  pid?: number
}
export type AttachedResponse = {
  type: "attached"
  reqId: string
  id: string
  backlog: string
}
export type NotFoundResponse = { type: "notFound"; reqId: string; id: string }
export type DataMessage = { type: "data"; id: string; chunk: string }
export type ExitMessage = {
  type: "exit"
  id: string
  exitCode: number
  signal: number | null
}

export type DaemonMessage =
  | CreatedResponse
  | AttachedResponse
  | NotFoundResponse
  | DataMessage
  | ExitMessage

export function isDaemonRequest(value: unknown): value is DaemonRequest {
  const op = (value as { op?: unknown } | null)?.op
  return (
    op === "create" ||
    op === "attach" ||
    op === "write" ||
    op === "resize" ||
    op === "kill"
  )
}

export function isDaemonMessage(value: unknown): value is DaemonMessage {
  const type = (value as { type?: unknown } | null)?.type
  return (
    type === "created" ||
    type === "attached" ||
    type === "notFound" ||
    type === "data" ||
    type === "exit"
  )
}
