import * as React from "react"
import * as ReactJsxRuntime from "react/jsx-runtime"
import * as ReactDom from "react-dom"
import * as ReactDomClient from "react-dom/client"

/**
 * The modules a built-in plugin gets from the app rather than bundling a copy.
 *
 * React above all: two Reacts in one page are two sets of hooks, and a
 * component from one rendered under the other throws on its first `useState`.
 * So `scripts/build-plugins.mjs` turns a plugin's `import … from "react"` into
 * a read of this global, and the list there has to name the same specifiers as
 * the one here — a plugin importing one this does not expose fails at load with
 * a message saying which.
 *
 * Only what has to be one copy. A plugin's own copy of a stateless helper — an
 * icon, `cn`, a shadcn component built on top of this React — costs bytes and
 * nothing else, and sharing it would make the app's internals a contract.
 */
export const SHARED_GLOBAL = "__VSCLAUDE_SHARED__"

export function exposeSharedModules(): void {
  ;(globalThis as Record<string, unknown>)[SHARED_GLOBAL] = {
    react: React,
    "react/jsx-runtime": ReactJsxRuntime,
    // `createPortal` and `flushSync` are on this one, and every dialog and
    // menu a plugin draws through base-ui reaches for them.
    "react-dom": ReactDom,
    "react-dom/client": ReactDomClient,
  }
}
