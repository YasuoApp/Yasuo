/*
 * `import.meta.glob`, which Vite provides and this project does not take the
 * rest of `vite/client` for.
 *
 * The renderer needs exactly this one thing from those types — see
 * `lib/files/icons.ts`, which collects the file-type icons with it — and the
 * ambient `*.css` / `*.svg` modules that would come with the full set are a
 * wider claim than the files already declaring what they import.
 *
 * Narrower than Vite's own signature on purpose: every call here is eager and
 * asks for the default export, so a record of URLs is the only shape this
 * project can get back, and a call that is not those two would be typed wrong
 * rather than typed loosely.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options: { eager: true; query: "?url"; import: "default" }
  ): Record<string, string>
}
