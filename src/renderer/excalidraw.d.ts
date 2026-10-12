/*
 * Excalidraw's stylesheet, which its own `exports` map publishes without types.
 *
 * Vite resolves `./index.css` through that map and hands back a module like any
 * other CSS import; TypeScript follows the same map, finds no `types` beside
 * the two conditions, and calls it missing. Declaring it here says what is
 * already true rather than widening `*.css`, which the renderer's own
 * stylesheets already resolve without help.
 *
 * A file of its own, and deliberately without imports: an ambient module
 * declaration is only global in a `.d.ts` that is not itself a module, and
 * `global.d.ts` next door imports `DesktopApi`.
 */
declare module "@excalidraw/excalidraw/index.css"
