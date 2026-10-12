import { nameOf } from "./paths"

/**
 * Which icon a file is drawn with — the name only, not the file behind it.
 *
 * Kept apart from `icons.ts` because that one reaches for the bundler
 * (`import.meta.glob`) and this one is a table: the question "what is a `.tsx`"
 * can then be asked in a test without a Vite build, and the answer is the same
 * one the tree uses.
 *
 * Names here are the vscode-icons ones with their `file_type_` prefix and
 * `.svg` suffix taken off, so a row in these tables is also the name of a file
 * in `assets/file-icons/`. Adding a type is dropping the icon in and adding the
 * line — there is no third place to update.
 */

/**
 * By extension, which is what decides it for almost everything.
 *
 * Several extensions share an icon on purpose: `.mts` is TypeScript, `.bash`
 * is a shell script, and a `.7z` is a zip as far as a tree is concerned. What
 * is deliberately absent is a per-language icon for every language — this is
 * the set a workspace in this studio actually holds, and each entry is a file
 * checked into the repository.
 */
const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "reactts",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "reactjs",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  prisma: "prisma",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  ico: "image",
  svg: "svg",
  woff: "font",
  woff2: "font",
  ttf: "font",
  otf: "font",
  pdf: "pdf",
  zip: "zip",
  tar: "zip",
  gz: "zip",
  tgz: "zip",
  rar: "zip",
  "7z": "zip",
  txt: "text",
  log: "log",
  env: "dotenv",
  mk: "gnu",
  mak: "gnu",
  m4: "gnu",
  cmake: "cmake",
}

/**
 * By whole name, for the files whose extension says nothing about them.
 *
 * `package.json` is npm rather than JSON and `tsconfig.json` is TypeScript's
 * config rather than either, which is the whole reason this table sits in front
 * of the one above.
 */
const BY_FILENAME: Record<string, string> = {
  // Extensionless, and so invisible to the table above — which is the whole
  // reason this one is walked first. `makefile` is `gnu` because that is what
  // vscode-icons itself calls it: there is no makefile icon in the set, and
  // `am`, `ld` and `m4` are filed under the same one.
  makefile: "gnu",
  gnumakefile: "gnu",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  "gemfile.lock": "ruby",
  rakefile: "ruby",
  "cargo.toml": "rust",
  "cargo.lock": "rust",
  "go.mod": "go",
  "go.sum": "go",
  "requirements.txt": "python",
  ".editorconfig": "editorconfig",
  "package.json": "npm",
  "package-lock.json": "npm",
  ".npmrc": "npm",
  "bun.lock": "bun",
  "bun.lockb": "bun",
  dockerfile: "docker",
  ".dockerignore": "docker",
  ".gitignore": "git",
  ".gitattributes": "git",
  ".gitmodules": "git",
  ".nvmrc": "node",
  ".env": "dotenv",
}

/**
 * By how a name starts, for the families that spell themselves several ways.
 *
 * A prefix rather than a pattern: `tsconfig.app.json`, `.env.local` and
 * `vite.config.ts` all differ only after a stem that is itself the answer, and
 * a list of prefixes is a thing somebody can read and add to. Longest first, so
 * `docker-compose` is not claimed by a shorter neighbour.
 */
const BY_PREFIX: [prefix: string, icon: string][] = [
  ["docker-compose", "docker"],
  ["tsconfig", "tsconfig"],
  ["tailwind.config", "tailwind"],
  ["prettier.config", "prettier"],
  // `.prettierrc`, `.prettierrc.json`, `.prettierignore` — the stem is the
  // answer and everything after it is a variation on how to spell the file.
  [".prettier", "prettier"],
  ["eslint.config", "eslint"],
  [".eslint", "eslint"],
  ["vite.config", "vite"],
  ["vitest.config", "vite"],
  [".env", "dotenv"],
]

/** The extension, lowercased and without its dot. Empty for a name with none,
 * and for a dotfile, whose leading dot is part of the name. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1) : ""
}

/**
 * The icon for a path, or null for a type the studio has no icon checked in
 * for.
 *
 * Null rather than a stand-in, so the caller can fall back to the studio's own
 * Lucide glyphs: a coloured icon then means "this is a kind of file the studio
 * recognises", and everything else stays in the one iconography the rest of the
 * workbench uses.
 */
export function iconNameFor(filePath: string): string | null {
  const name = nameOf(filePath).toLowerCase()

  const exact = BY_FILENAME[name]
  if (exact) return exact

  for (const [prefix, icon] of BY_PREFIX) {
    if (name.startsWith(prefix)) return icon
  }

  return BY_EXTENSION[extensionOf(name)] ?? null
}
