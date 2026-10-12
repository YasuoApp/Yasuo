/**
 * The pieces of the updater with an opinion: which of two versions is newer,
 * which asset in a release is this machine's, and what a half-finished install
 * says on the button.
 *
 * Worth a test rather than a glance, because both ways of getting it wrong are
 * silent. Say `1.0.9` is newer than `1.0.19` — string comparison, the obvious
 * implementation — and every user is offered a downgrade forever. Say a
 * prerelease is newer than the release it precedes and the same thing happens
 * to whoever is running one.
 */
import { dmgAsset, isNewer, versionParts } from "../src/main/updater"
import { downloadPercent, installLabel } from "../src/renderer/lib/updates"
import { check, finish, section } from "./harness"

section("versionParts")

check("splits a plain version", versionParts("1.0.19").join(".") === "1.0.19")
check("drops a leading v", versionParts("v1.0.19").join(".") === "1.0.19")
check(
  "stops at a prerelease rather than folding it in",
  versionParts("1.0.20-beta.1").join(".") === "1.0.20"
)
check("reads a non-number as zero", versionParts("1.x.3").join(".") === "1.0.3")

section("isNewer")

check("a later patch", isNewer("1.0.20", "1.0.19"))
check(
  "compares numerically, not as text — the bug this exists for",
  isNewer("1.0.19", "1.0.9")
)
check("a later minor", isNewer("1.1.0", "1.0.99"))
check("the same version is not newer", !isNewer("1.0.19", "1.0.19"))
check("a tag's v changes nothing", !isNewer("v1.0.19", "1.0.19"))
check(
  "an older release is never offered — a dev build stays put",
  !isNewer("1.0.19", "1.0.20")
)
check("a release beats its own prerelease", isNewer("1.0.20", "1.0.20-beta.1"))
check(
  "a prerelease of the version you have is not an update",
  !isNewer("1.0.20-beta.1", "1.0.20")
)
check(
  "a shorter version is padded rather than treated as smaller",
  !isNewer("1.0", "1.0.0")
)
check("and the other way round", isNewer("1.0.1", "1.0"))

section("dmgAsset")

const release = {
  assets: [
    {
      name: "Visual Studio Claude-1.0.24-x64.dmg",
      browser_download_url: "x64",
      size: 120,
    },
    {
      name: "Visual Studio Claude-1.0.24-arm64.dmg",
      browser_download_url: "arm",
      size: 130,
    },
    {
      name: "Visual Studio Claude-1.0.24-arm64.zip",
      browser_download_url: "zip",
      size: 90,
    },
  ],
}

check("picks this arch's dmg", dmgAsset(release, "arm64")?.url === "arm")
check("and the other one", dmgAsset(release, "x64")?.url === "x64")
check(
  "a .zip of the right arch is not a .dmg",
  dmgAsset({ assets: [release.assets[2]] }, "arm64") === null
)
check(
  "an arch with no build is null, not the first asset going",
  dmgAsset(release, "riscv") === null
)
check("a release with no assets", dmgAsset({ assets: [] }, "arm64") === null)
check("and one that is not a release at all", dmgAsset(null, "arm64") === null)
check(
  "a missing size reads as unknown rather than throwing",
  dmgAsset(
    { assets: [{ name: "a-arm64.dmg", browser_download_url: "u" }] },
    "arm64"
  )?.size === 0
)

section("downloadPercent")

check("nothing installing", downloadPercent(null) === null)
check(
  "bytes against a total",
  downloadPercent({
    stage: "downloading",
    version: "1",
    received: 50,
    total: 200,
  }) === 25
)
check(
  "an unknown total is indeterminate, not 0% — a bar stuck at zero for a minute",
  downloadPercent({
    stage: "downloading",
    version: "1",
    received: 50,
    total: 0,
  }) === null
)
check(
  "clamped: a content-length that undercounts must not print 101%",
  downloadPercent({
    stage: "downloading",
    version: "1",
    received: 210,
    total: 200,
  }) === 100
)
check(
  "the install stage has no percentage to give",
  downloadPercent({ stage: "installing", version: "1" }) === null
)

section("installLabel")

check("idle", installLabel(false, null) === "Update and reopen")
check(
  "started, before the first byte",
  installLabel(true, null) === "Downloading…"
)
check(
  "downloading",
  installLabel(true, {
    stage: "downloading",
    version: "1",
    received: 1,
    total: 3,
  }) === "Downloading 33%"
)
check(
  "handed over to the script",
  installLabel(true, { stage: "installing", version: "1" }) === "Installing…"
)

finish()
