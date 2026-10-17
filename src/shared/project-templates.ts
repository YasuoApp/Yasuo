/*
 * A new project from a framework's own starter: Next, Nuxt or Vite.
 *
 * Nothing here holds a template. What a starter contains is the framework's
 * business and changes every release, so the app names the framework's own
 * `create-*` CLI at `@latest` and runs it in a dock shell inside the empty
 * directory — where its questions (ESLint? Tailwind? install now?) can be
 * answered, which no background process could do. Shared because main refuses
 * a bad name with the same rule the dialog draws its hint from.
 */

export type PackageManager = "npm" | "pnpm" | "bun"

export const PACKAGE_MANAGERS: readonly PackageManager[] = [
  "npm",
  "pnpm",
  "bun",
]

export type ProjectTemplate = {
  id: string
  label: string
  /** The line under the label in the picker. */
  caption: string
  /** A logo in the renderer's `assets/brand-icons/`, by file name. A name,
   * not a URL, because main imports this module too. */
  icon: string
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  { id: "next", label: "Next.js", caption: "React, App Router", icon: "next" },
  { id: "nuxt", label: "Nuxt", caption: "Vue, full-stack", icon: "nuxt" },
  {
    id: "vite-react-ts",
    label: "Vite + React",
    caption: "TypeScript",
    icon: "react",
  },
  {
    id: "vite-vue-ts",
    label: "Vite + Vue",
    caption: "TypeScript",
    icon: "vue",
  },
  {
    id: "vite-svelte-ts",
    label: "Vite + Svelte",
    caption: "TypeScript",
    icon: "svelte",
  },
  {
    id: "vite-vanilla-ts",
    label: "Vite",
    caption: "No framework, TypeScript",
    icon: "vite",
  },
]

/** How each package manager runs a package it has not installed. */
const RUNNER: Record<PackageManager, string> = {
  npm: "npx",
  pnpm: "pnpm dlx",
  bun: "bunx",
}

/**
 * The line typed into the shell, always aimed at `.`: the directory exists
 * before the CLI runs, because the folder has to be in the workspace for its
 * shell to start there. The package manager is named outright as well as being
 * the runner, since `npx` under a pnpm user's PATH would otherwise leave an
 * npm lock file behind.
 */
export function scaffoldCommand(
  templateId: string,
  manager: PackageManager
): string | null {
  const run = RUNNER[manager]
  if (templateId === "next") {
    return `${run} create-next-app@latest . --use-${manager}`
  }
  if (templateId === "nuxt") {
    return `${run} nuxi@latest init . --packageManager ${manager}`
  }
  if (templateId.startsWith("vite-")) {
    const variant = templateId.slice("vite-".length)
    return `${run} create-vite@latest . --template ${variant}`
  }
  return null
}

/**
 * Why `name` cannot be the new directory, or null when it can.
 *
 * Stricter than the filesystem on purpose: each of these CLIs, aimed at `.`,
 * takes the directory's name as the package's, and refuses — after the
 * directory was made — one npm would not publish. So the npm rule is applied
 * here, before anything is written: lower case, no spaces, no leading dot or
 * underscore, 214 characters at most.
 */
export function projectNameProblem(name: string): string | null {
  if (!name) return "Give it a name."
  if (name.length > 214) return "That name is too long."
  if (/[A-Z]/.test(name)) return "Use lower case — it becomes the package name."
  if (/^[._]/.test(name)) return "It cannot start with a dot or an underscore."
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return "Letters, digits, dots, dashes and underscores only."
  }
  return null
}
