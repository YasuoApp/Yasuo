<div align="center">

<img src="docs/banner.svg" alt="Yasuo: each project's agent conversations, listed and answering, collapsed into one window and one tab strip" width="900">

# Yasuo

**One window for a project's agents, the diff they leave, and the commit that ends it.**

[![CI](https://github.com/YasuoApp/Yasuo/actions/workflows/ci.yml/badge.svg)](https://github.com/YasuoApp/Yasuo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-43-47848F.svg)](https://electronjs.org)

</div>

---

Yasuo runs `claude` against the folders you already work in, and makes each conversation a tab. A project's chats sit under its name, whichever is answering says so, and the diff they leave is a tab in the same window.

Agents run **in the folder itself** — no branch to name, no worktree to remove, nothing to merge back, and what an agent changed is what `git status` says it changed. The cost is that two agents on one folder edit the same files: this is a studio for conversations you are watching, not a farm of them you are not.

One **workspace**, any number of **folders**, no switching between them. Each project has its chats, an Explorer with its files, its changes and its commits, and a terminal docked under the pane. [`docs/design.md`](docs/design.md) is what each one is for and why it behaves as it does.

- **Talk while it works.** A message sent mid-answer goes to the same `claude` and is marked `Queued` until the turn ends; `Stop` interrupts rather than kills.
- **See every chat at a glance.** A row spins while its chat works, shows a shield when it stops on a question, and stays marked unread until you have read the answer — in the column, the menu bar and an OS notification.
- **Five permission modes, switched mid-chat** — `Plan`, `Read only`, `Ask`, `Edits`, `Full access` — without throwing away the prompt cache.
- **From diff to commit.** Stage from the `Changes` list, have the message drafted off the staged diff, read the branch's history under `Commits`.
- **A worktree is a button.** Cut a `git worktree` from a project's row; leave the branch blank and the first chat in it names both.
- **Find anything.** `⇧⌘F` searches every file and every chat; `⌘F` finds inside the conversation on screen.

## Install

Every build is **unsigned**, so each OS objects in its own way. That is what the last line of each section is about.

### macOS

macOS 12 (Monterey) or newer, Apple Silicon or Intel.

```bash
curl -fsSL https://raw.githubusercontent.com/YasuoApp/Yasuo/main/install.sh | bash
```

[`install.sh`](install.sh) picks the build for your architecture and copies it into `/Applications`. Run it again to update, or `| bash -s 1.0.0` to pin a version.

Use `curl` rather than a browser: macOS quarantines a download and Gatekeeper then calls the app _"damaged"_, which only ever means unsigned. A `.dmg` from [Releases][releases] works too, after `xattr -dr com.apple.quarantine "/Applications/Yasuo.app"` — which skips the check rather than passing it.

### Linux

x64. The AppImage from [Releases][releases] is the whole install.

```bash
chmod +x Yasuo-*-x64.AppImage
./Yasuo-*-x64.AppImage
```

It needs FUSE (`sudo apt install libfuse2` on Debian and Ubuntu), or `--appimage-extract-and-run` without it.

### Windows

x64. The `.exe` from [Releases][releases] is an NSIS installer. SmartScreen stops it: _More info_ → _Run anyway_.

[releases]: https://github.com/YasuoApp/Yasuo/releases

Yasuo is developed and used day to day on macOS; the Linux and Windows builds come out of the same workflow and the tests run on Linux, but assume rough edges. `claude` is needed only for agent sessions and the AI features — not to start the app.

## From source

Needs [Bun](https://bun.sh) 1.3+ and Node 20+.

```bash
git clone https://github.com/YasuoApp/Yasuo.git
cd yasuo
bun install
bun run dev      # bundles the main process, starts Vite, launches Electron at it
```

`bun run test`, `lint`, `typecheck` and `build` are the rest. A `Makefile` wraps packaging: `make dmg` for this machine's architecture, `make help` for the others. Builds are unsigned unless `SIGN=1`.

## Documentation

- **[`docs/design.md`](docs/design.md)**: what each panel is for and why it behaves as it does. Read this before changing one.
- **[`CONTRIBUTING.md`](CONTRIBUTING.md)**: the layout, the IPC contract the main process and the renderer talk over, and where the seams are.
- **[`SECURITY.md`](SECURITY.md)**: the security model, and how to report a vulnerability.

Contributions are welcome. A new agent CLI and a new panel are both designed to be added to. Small fixes need no ceremony; anything structural is worth an issue first.

## License

[MIT](LICENSE).
