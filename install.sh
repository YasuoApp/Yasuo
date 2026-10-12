#!/usr/bin/env bash
#
# Installs Visual Studio Claude into /Applications from a GitHub release.
#
#   ./install.sh            the latest release
#   ./install.sh 0.1.0      that release
#
# VSCLAUDE_UPDATE_DMG names a .dmg already on disk, which is how the app's own
# "Update and reopen" runs this: it downloads the asset itself so it can draw a
# percentage, then hands the file over. The file is deleted afterwards.
#
# The download is the point of this script. macOS puts `com.apple.quarantine`
# on anything a browser, Mail or AirDrop hands over, and Gatekeeper refuses a
# quarantined app that carries no Developer ID — which these builds do not,
# since signing one costs an Apple Developer membership. `curl` sets no such
# attribute, so an app installed this way opens normally. That is a check being
# skipped rather than passed: what you get is the integrity of the transfer,
# not proof of who built the file. Read this script before running it.

set -euo pipefail

REPO="vsclaude/visual-studio-claude"
# Overridable so the script can be exercised against a scratch directory.
APPLICATIONS="${APPLICATIONS:-/Applications}"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "This installer is for macOS only." >&2; exit 1 ;;
esac

# Electron 43 sets LSMinimumSystemVersion to 12.0, and an older macOS fails at
# launch with nothing that says why.
MACOS_MAJOR=$(sw_vers -productVersion | cut -d. -f1)
if [ "$MACOS_MAJOR" -lt 12 ]; then
  echo "Visual Studio Claude needs macOS 12 (Monterey) or newer." >&2
  echo "This machine runs $(sw_vers -productVersion)." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ ! -w "$APPLICATIONS" ]; then
  echo "$APPLICATIONS is not writable by $(whoami)." >&2
  exit 1
fi

# The asset is asked for by architecture rather than built out of a version and
# a naming template: a release whose files are named something else should fail
# as "no arm64 build here" instead of as a 404 on a URL this script invented.
asset_url() {
  curl -fsL "$1" \
    | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
    | sed 's/.*"\(https[^"]*\)"/\1/' \
    | grep -- "-${ARCH}\.dmg$" \
    | head -1
}

# A .dmg the app downloaded itself before running this, so that the progress bar
# in its window is a real measure: the download is the long part of an install
# and the only one the app is still alive for — everything below the `quit` is
# not drawable. Treated as a temporary of this run and deleted with the rest.
PREFETCHED="${VSCLAUDE_UPDATE_DMG:-}"
if [ -n "$PREFETCHED" ] && [ ! -f "$PREFETCHED" ]; then
  echo "No such file: $PREFETCHED — downloading instead." >&2
  PREFETCHED=""
fi

VERSION="${1:-}"
if [ -n "$PREFETCHED" ]; then
  URL=""
elif [ -n "$VERSION" ]; then
  echo "Looking up the release…"
  # Both tag spellings, because which one a release used is not something the
  # person running this should have to know.
  URL=$(asset_url "https://api.github.com/repos/$REPO/releases/tags/v${VERSION#v}") || true
  [ -n "${URL:-}" ] ||
    URL=$(asset_url "https://api.github.com/repos/$REPO/releases/tags/${VERSION#v}") || true
else
  URL=$(asset_url "https://api.github.com/repos/$REPO/releases/latest") || true
fi

if [ -z "$PREFETCHED" ] && [ -z "${URL:-}" ]; then
  echo "No ${ARCH} .dmg in ${VERSION:-the latest release} of $REPO." >&2
  echo "See https://github.com/$REPO/releases" >&2
  exit 1
fi

TMP=$(mktemp -d)
MOUNT="$TMP/mnt"
cleanup() {
  # Detaching a volume that was never attached is not an error worth printing.
  hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$TMP"
  [ -n "$PREFETCHED" ] && rm -f "$PREFETCHED"
  return 0
}
trap cleanup EXIT

if [ -n "$PREFETCHED" ]; then
  DMG="$PREFETCHED"
  echo "Using $(basename "$DMG")…"
else
  DMG="$TMP/app.dmg"
  echo "Downloading $(basename "${URL//%20/ }")…"
  curl -fL --progress-bar -o "$DMG" "$URL"
fi

mkdir -p "$MOUNT"
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MOUNT"

APP_SRC=$(find "$MOUNT" -maxdepth 1 -name "*.app" -print -quit)
if [ -z "$APP_SRC" ]; then
  echo "No .app inside the disk image." >&2
  exit 1
fi
APP_NAME=$(basename "$APP_SRC")

# Replacing a bundle out from under a running process leaves it half-swapped,
# and the pty daemon it spawned holds a socket in ~/.vsclaude that a new
# build would then talk to.
quit_app() {
  if pgrep -qx "$1"; then
    echo "Quitting $1…"
    osascript -e "quit app \"$1\"" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -qx "$1" || break
      sleep 0.5
    done
  fi
}
quit_app "${APP_NAME%.app}"

# The same app under the name it had before it was Visual Studio Claude. Left
# in place it would be a second copy, still on the old version, that the Dock
# and Spotlight keep offering.
LEGACY_APP="Yasuo.app"
if [ "$APP_NAME" != "$LEGACY_APP" ] && [ -d "$APPLICATIONS/$LEGACY_APP" ]; then
  quit_app "${LEGACY_APP%.app}"
  echo "Removing $LEGACY_APP, which this replaces…"
  rm -rf "$APPLICATIONS/$LEGACY_APP"
fi

rm -rf "$APPLICATIONS/$APP_NAME"
# `ditto` rather than `cp -R`: it is the macOS tool for copying a bundle, and it
# carries the symlinks and metadata inside a Framework unchanged.
ditto "$APP_SRC" "$APPLICATIONS/$APP_NAME"

if xattr -p com.apple.quarantine "$APPLICATIONS/$APP_NAME" >/dev/null 2>&1; then
  # Nothing here should have set it, so this means the assumption above no
  # longer holds — say so rather than let Gatekeeper be the one to explain.
  echo
  echo "Warning: the installed app is quarantined and macOS will refuse to open it."
  echo "Remove it with:"
  echo "  xattr -dr com.apple.quarantine \"$APPLICATIONS/$APP_NAME\""
fi

echo
echo "Installed $APP_NAME to $APPLICATIONS"
echo "Open it with:  open \"$APPLICATIONS/$APP_NAME\""
