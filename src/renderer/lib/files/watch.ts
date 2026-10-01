import { useStudio } from "../store"
import { gitStateOf, rootIdOf, useGitStatus } from "./git-status"
import { nameOf } from "./paths"
import { fileRoots } from "./roots"
import { useFiles } from "./store"

/**
 * Keeps the main process watching exactly the folders the tree has open, and
 * re-reads the ones it reports.
 *
 * A module of its own rather than more subscriptions inside the store: the
 * store is what a test imports, and it stubs `window.desktop` with the handful
 * of methods it needs — a subscription taken at module scope there would be a
 * bridge call in every test that has ever read a file.
 *
 * Started once from the workbench rather than from the Explorer panel, which is
 * unmounted whenever the rail moves to another section: the tree keeps its
 * `expanded` while it is off screen, and a folder that stopped being watched
 * because somebody looked at the Database panel would come back stale.
 */
export function watchExpandedDirectories(): () => void {
  /** The last set actually sent, so a store write that left `expanded` alone —
   * a keystroke in an editor, a tab opening — does not cross the bridge. */
  let sent = ""

  const push = (expanded: string[]) => {
    // Sorted, so the same set of folders reached in a different order (a
    // reveal from the palette opens a chain from the top) is the same message.
    const dirs = [...expanded].sort()
    // The roots are in the key too: main watches each one recursively off this
    // same call, so a folder added with nothing expanded must still send one.
    const roots = fileRoots()
      .map((root) => root.id)
      .sort()
    const key = [...roots, "", ...dirs].join("\n")
    if (key === sent) return
    sent = key
    void window.desktop.watchDirectories(dirs)
  }

  push(useFiles.getState().expanded)
  const stopFollowing = useFiles.subscribe((state) => push(state.expanded))
  const stopFollowingRoots = useStudio.subscribe((studio, previous) => {
    if (studio.folders !== previous.folders) push(useFiles.getState().expanded)
  })

  /*
   * Anything under a root, expanded or not — what keeps the `Changes` list
   * current without Refresh. A path git already calls ignored is dropped, so a
   * build rewriting `dist/` is not a `git status` per save; a path git has not
   * seen yet (a new file) is not ignored, and does schedule one.
   */
  const stopListeningTree = window.desktop.onTreeChanged(
    ({ root, paths, overflow }) => {
      const git = useGitStatus.getState()
      const roots = new Set<string>()
      for (const changed of paths) {
        if (gitStateOf(git, changed) === "ignored") continue
        const rootId = rootIdOf(changed)
        if (rootId !== null) roots.add(rootId)
      }
      if (overflow) {
        const rootId = rootIdOf(root)
        if (rootId !== null) roots.add(rootId)
      }
      for (const rootId of roots) git.schedule(rootId)
    }
  )

  const stopListening = window.desktop.onDirectoryChanged(({ dir }) => {
    void useFiles.getState().syncDirs([dir])

    // What changed in it may have changed what git says about it. Debounced in
    // the git store rather than here, since a checkout reports every directory
    // it touched and they all mean the same one read.
    const rootId = rootIdOf(dir)
    if (rootId !== null) useGitStatus.getState().schedule(rootId)

    // `.git` is watched for exactly this: the branch beside the folder, and
    // the row colours above, are both wrong the moment somebody commits or
    // checks out in the dock's shell. It is never a directory the tree has
    // open, so nothing above did anything with it.
    if (nameOf(dir) === ".git") void useStudio.getState().refreshBranches()
  })

  return () => {
    stopFollowing()
    stopFollowingRoots()
    stopListening()
    stopListeningTree()
    // Nothing is left watching a directory nobody is listening about — which
    // is also what makes Strict Mode's double mount harmless, since the set is
    // sent again on the way back in.
    void window.desktop.watchDirectories([])
  }
}
