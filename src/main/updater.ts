import { spawn } from "node:child_process"
import { closeSync, createWriteStream, openSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"

import type { UpdateCheck } from "../shared/api"
import { dataDir } from "./data-dir"

/**
 * Whether there is a newer Visual Studio Claude, and installing it.
 *
 * **Not `electron-updater`, and deliberately.** Squirrel.Mac will not replace a
 * bundle that carries no Developer ID, and these builds carry none — signing
 * costs an Apple Developer membership, which is the same reason `install.sh`
 * exists at all. So the whole of the update story here is: ask GitHub what the
 * latest release is, compare it against this build, and run the very script the
 * README already tells people to paste into a terminal. Nothing is downloaded
 * in the background, nothing is staged, and there is no delta.
 *
 * The one thing this process does fetch is the `.dmg` itself, and only once the
 * button is pressed (`downloadUpdate`) — because the download *is* the wait,
 * about a hundred megabytes of it, and it is the one phase the window is still
 * alive for. `install.sh` quits the app before it copies anything, so a
 * percentage is honest up to there and nothing after it could be drawn at all.
 *
 * Free of `electron` — this process's own version, and where the script it runs
 * lives, are arguments — so `test/updates.ts` can import it under plain `bun`,
 * the same bargain `git.ts` makes.
 */

const REPO = "vsclaude/visual-studio-claude"

const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`

/** Where "What's new" goes, and the fallback button on anything but macOS. */
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`

/**
 * A check runs unasked, on a timer, so it must not be able to hang about: an
 * unreachable GitHub should read as `unknown` within a few seconds rather than
 * leave a request pending for however long the OS's default is.
 */
const REQUEST_TIMEOUT_MS = 10_000

/** The installer's output, kept because the app it is updating quits halfway
 * through and has nowhere left to show a failure. */
export function updateLogPath(): string {
  return path.join(dataDir(), "update.log")
}

/**
 * A version as numbers, for comparing.
 *
 * Anything that is not a run of digits ends the list rather than being coerced,
 * so `1.0.20-beta.1` is `[1, 0, 20]` and its prerelease is handled separately —
 * a `-beta` sorting as a fourth component would make it *newer* than the
 * release it precedes.
 */
export function versionParts(version: string): number[] {
  const core = version.replace(/^v/, "").split(/[-+]/, 1)[0] ?? ""
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isNaN(value) ? 0 : value
  })
}

function isPrerelease(version: string): boolean {
  return /[-+]/.test(version.replace(/^v/, ""))
}

/**
 * Whether `candidate` is a release worth offering to somebody on `current`.
 *
 * Strictly newer, never merely different: a machine running a build ahead of
 * the latest release — anyone who ran `make app` from a checkout — should be
 * told nothing rather than offered a downgrade dressed up as an update.
 */
export function isNewer(candidate: string, current: string): boolean {
  const left = versionParts(candidate)
  const right = versionParts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  // Same numbers: `1.0.20` is newer than `1.0.20-beta.1`, and nothing else
  // about two prereleases of one version is worth guessing at.
  return isPrerelease(current) && !isPrerelease(candidate)
}

type Release = { version: string; notes: string; url: string }

/** The shape of the one release GitHub is asked for, checked rather than cast:
 * this is JSON off the network. */
function asRelease(value: unknown): Release | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const tag = record.tag_name
  if (typeof tag !== "string" || tag.length === 0) return null
  return {
    version: tag.replace(/^v/, ""),
    notes: typeof record.body === "string" ? record.body : "",
    url: typeof record.html_url === "string" ? record.html_url : RELEASES_PAGE,
  }
}

async function latestRelease(): Promise<Release> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub rejects an anonymous API request with no user agent outright,
      // and the rejection is a 403 that reads like rate limiting.
      "User-Agent": "Visual-Studio-Claude",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}.`)
  }
  const release = asRelease(await response.json())
  if (!release) throw new Error("The latest release has no tag.")
  return release
}

/**
 * What the update badge is drawn from.
 *
 * `platform` decides only whether the button can install or merely link — the
 * check itself is worth doing everywhere, because "there is a newer version"
 * is true on Windows too even when this app cannot be the one to fetch it.
 */
export async function checkForUpdate(
  current: string,
  platform: NodeJS.Platform
): Promise<UpdateCheck> {
  let release: Release
  try {
    release = await latestRelease()
  } catch (error) {
    return {
      status: "unknown",
      current,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (!isNewer(release.version, current)) return { status: "current", current }
  return {
    status: "available",
    version: release.version,
    current,
    notes: release.notes,
    url: release.url,
    installable: platform === "darwin",
  }
}

/**
 * How often a download says where it got to.
 *
 * A hundred megabytes arrives as a few thousand chunks and every one of them
 * would otherwise be an IPC message and a React render. Ten a second is a bar
 * that still moves smoothly.
 */
const PROGRESS_INTERVAL_MS = 100

type Asset = { url: string; name: string; size: number }

/**
 * The `.dmg` for one architecture among a release's assets.
 *
 * Found by the suffix of the asset's *own* name, which is how `install.sh`
 * finds it too — never by building a filename out of a version and a template,
 * so a release whose files are named something else fails as "no arm64 build
 * here" rather than as a 404 on a URL this app invented.
 */
export function dmgAsset(release: unknown, arch: string): Asset | null {
  if (typeof release !== "object" || release === null) return null
  const assets = (release as Record<string, unknown>).assets
  if (!Array.isArray(assets)) return null
  for (const entry of assets) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = record.name
    const url = record.browser_download_url
    if (typeof name !== "string" || typeof url !== "string") continue
    if (!name.endsWith(`-${arch}.dmg`)) continue
    // An absent or nonsense size reads as zero, which is "total unknown" — the
    // bar draws that as indeterminate rather than as a percentage of nothing.
    const size =
      typeof record.size === "number" && record.size > 0 ? record.size : 0
    return { name, url, size }
  }
  return null
}

/** A release by tag, in both spellings — which one a release used is not
 * something anything here should have to know, the same reason `install.sh`
 * tries both. */
async function releaseByTag(version: string): Promise<unknown> {
  const bare = version.replace(/^v/, "")
  for (const tag of [`v${bare}`, bare]) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Visual-Studio-Claude",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    )
    if (response.ok) return response.json()
    // Anything but "no such tag" is worth saying out loud: a 403 here is rate
    // limiting, and retrying it under the other spelling would report it as a
    // missing release.
    if (response.status !== 404) {
      throw new Error(`GitHub answered ${response.status}.`)
    }
  }
  throw new Error(`No release tagged ${bare}.`)
}

/**
 * Downloads a release's `.dmg`, reporting how far it has got.
 *
 * Ahead of `install.sh` rather than inside it: the script's own `curl` writes a
 * progress bar to a log file nobody is reading, and this is the only phase of
 * an install that can be drawn in the window — everything after it happens with
 * the app already quit.
 *
 * Answers with the file's path, which is handed straight to the script.
 */
export async function downloadUpdate(input: {
  version: string
  /** `process.arch` — matches the `-arm64.dmg` / `-x64.dmg` suffix. */
  arch: string
  /** Called at most every `PROGRESS_INTERVAL_MS`, and once more at the end.
   * `total` is 0 when the release does not say how large the asset is. */
  onProgress: (received: number, total: number) => void
}): Promise<string> {
  const asset = dmgAsset(await releaseByTag(input.version), input.arch)
  if (!asset) {
    throw new Error(`No ${input.arch} .dmg in ${input.version}.`)
  }

  const dir = path.join(dataDir(), "updates")
  // Emptied rather than added to: this holds one asset at a time, and an
  // install that failed halfway should not leave a hundred megabytes behind for
  // the next one to sit beside.
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, asset.name)

  // No timeout on this one, unlike the metadata requests above: a slow link is
  // not a hung request, and there is a person watching the bar who can say when
  // they have had enough.
  const response = await fetch(asset.url, {
    headers: { "User-Agent": "Visual-Studio-Claude" },
  })
  if (!response.ok || !response.body) {
    throw new Error(`The download answered ${response.status}.`)
  }

  const declared = Number(response.headers.get("content-length"))
  const total =
    Number.isFinite(declared) && declared > 0 ? declared : asset.size

  let received = 0
  let announced = 0
  const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
  body.on("data", (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - announced < PROGRESS_INTERVAL_MS) return
    announced = now
    input.onProgress(received, total)
  })
  await pipeline(body, createWriteStream(file))
  // The last chunk is almost always inside the throttle window, so without this
  // the bar stops a per cent or two short of the install starting.
  input.onProgress(received, total)
  return file
}

/**
 * Runs `install.sh` for a version and reopens the app afterwards.
 *
 * **Detached, and that is the whole trick.** The script's third act is quitting
 * the app so that a bundle is not replaced out from under a running process —
 * it does that itself, `osascript` and a `pgrep` loop, because somebody running
 * it from a terminal needs it too. A child of the process being quit would die
 * with it midway through a `ditto`; a detached one outlives it and gets to the
 * `open` at the end.
 *
 * Output goes to a file for the same reason: by the time anything goes wrong,
 * the window that would have shown it is gone.
 */
export async function startInstaller(input: {
  /** The `install.sh` shipped inside the app bundle. */
  script: string
  version: string
  /** The bundle to reopen — where `install.sh` puts it, not where this process
   * happens to be running from. */
  appPath: string
  /** The `.dmg` `downloadUpdate` already fetched, so the script skips its own
   * `curl`. The script deletes it on the way out. */
  dmg?: string
}): Promise<void> {
  const logPath = updateLogPath()
  await mkdir(path.dirname(logPath), { recursive: true })
  // Truncated rather than appended: what matters is the run that just failed,
  // and this file is read by a person looking for exactly that.
  const log = openSync(logPath, "w")

  const child = spawn(
    "/bin/bash",
    [
      "-c",
      // Arguments rather than an interpolated string: a version is a value from
      // the network, and this one ends up on a command line.
      'bash "$1" "$2" && open "$3"',
      "vsclaude-update",
      input.script,
      input.version,
      input.appPath,
    ],
    {
      detached: true,
      stdio: ["ignore", log, log],
      // The one thing passed by environment rather than argument: the script's
      // positional arguments are its public interface — a version, from a
      // terminal — and a pre-downloaded file is this app talking to itself.
      env: input.dmg
        ? { ...process.env, VSCLAUDE_UPDATE_DMG: input.dmg }
        : process.env,
      // No cwd of this app's: it may be inside the bundle about to be replaced.
      cwd: path.dirname(logPath),
    }
  )
  // The child holds its own copy; this one would otherwise outlive the spawn.
  closeSync(log)
  child.unref()
}
