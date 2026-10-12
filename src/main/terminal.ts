import type { TerminalExit, TerminalOutput } from "../shared/api"
import { DaemonClient, type TerminalTarget } from "./daemon-client"
import { processCwd } from "./process-cwd"

export type { TerminalTarget }

type Emit = {
  data: (event: TerminalOutput) => void
  exit: (event: TerminalExit) => void
}

/**
 * Interactive shells, one pseudo-terminal each, rooted in a project's real
 * directory — from this process' point of view, at least.
 *
 * The pty itself lives in `daemon.ts`, a separate process this one talks to
 * over a socket (`DaemonClient`). That was once so a session could outlive the
 * app; it no longer does — `killAll()` on quit takes every one of them with
 * it, deliberately, so that a session always runs the command the current
 * build would give it rather than whatever it was started with. The daemon is
 * now just where the ptys happen to live.
 */
export class TerminalManager {
  private readonly client: DaemonClient
  /** Every shell this run started, and its pid where the daemon said one. */
  private readonly known = new Map<string, number | null>()

  constructor(emit: Emit) {
    this.client = new DaemonClient(emit)
  }

  /** Opens a shell against `target` and returns the id its events are tagged with. */
  async create(
    target: TerminalTarget,
    cols: number,
    rows: number
  ): Promise<string> {
    const { id, pid } = await this.client.create(target, cols, rows)
    this.known.set(id, pid)
    return id
  }

  /** Where the shell is now, after whatever `cd` was typed into it. */
  async cwd(terminalId: string): Promise<string | null> {
    const pid = this.known.get(terminalId)
    return pid ? processCwd(pid) : null
  }

  /** Forwards keystrokes. Unknown ids are ignored: the shell already exited. */
  async write(terminalId: string, data: string): Promise<void> {
    await this.client.write(terminalId, data)
  }

  /**
   * Tells the shell its new size, so full-screen programs redraw correctly.
   * A zero dimension means the pane is hidden, and is not sent on.
   */
  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    if (cols < 1 || rows < 1) return
    await this.client.resize(terminalId, cols, rows)
  }

  async kill(terminalId: string): Promise<void> {
    this.known.delete(terminalId)
    await this.client.kill(terminalId)
  }

  /**
   * Kills every shell this run of the app knows about.
   *
   * Awaited on quit, which is what makes a session's lifetime the app's:
   * fire-and-forget would let Electron exit before the daemon had been told,
   * leaving the very orphans this exists to prevent.
   */
  async killAll(): Promise<void> {
    await Promise.allSettled(
      [...this.known.keys()].map((terminalId) => this.kill(terminalId))
    )
  }
}
