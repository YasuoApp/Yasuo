/*
 * The images the main process imports.
 *
 * esbuild is told to load `.png` with its `dataurl` loader (see
 * `scripts/build-electron.mjs`), so the import is a `data:image/png;base64,…`
 * string that `nativeImage.createFromDataURL` reads — there is no file to find
 * at runtime, which is the point: `resources/` is not part of a packaged app.
 */
declare module "*.png" {
  const dataUrl: string
  export default dataUrl
}
