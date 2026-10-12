import { execFile } from "node:child_process"
import { promisify } from "node:util"

// A path rather than the package's own specifier, because its `exports` map
// does not list `package.json`. Inlined by esbuild, which is the point: the
// packaged app has no `node_modules` to read it from at runtime, and the SDK
// does not export the `VERSION` it carries.
import sdkPackage from "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json"
import type { ClaudeVersions } from "../shared/api"
import { claudeBinary } from "./claude-bin"
import { locate, spawnEnvironment } from "./shell-env"

const run = promisify(execFile)

/**
 * Which `claude` a chat runs on and which SDK drives it — Settings › Updates.
 *
 * The CLI's version is asked of the CLI rather than remembered: it updates
 * itself underneath this app, so the answer is only as old as the last ask.
 */
export async function claudeVersions(): Promise<ClaudeVersions> {
  const sdk = sdkPackage.version
  const binary = await locate(claudeBinary())
  if (!binary) {
    return {
      cli: null,
      sdk,
      error: `Could not find \`${claudeBinary()}\` on your PATH. Set CLAUDE_BIN if it is installed somewhere unusual.`,
    }
  }

  try {
    const { stdout } = await run(binary, ["--version"], {
      cwd: process.env.HOME ?? undefined,
      env: await spawnEnvironment({}),
      timeout: TIMEOUT_MS,
    })
    return { cli: readCliVersion(stdout), sdk, error: null }
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim()
    return {
      cli: null,
      sdk,
      error: stderr || (error instanceof Error ? error.message : String(error)),
    }
  }
}

/** Long enough for the login-shell resolve `locate` pays for. */
const TIMEOUT_MS = 15_000

/** `2.1.3 (Claude Code)` → `2.1.3`; anything else is shown as printed. */
export function readCliVersion(stdout: string): string | null {
  const line = stdout.trim().split("\n", 1)[0]?.trim() ?? ""
  if (!line) return null
  return /^v?(\d+\.\d+\.\d+\S*)/.exec(line)?.[1] ?? line
}
