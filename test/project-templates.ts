import {
  PACKAGE_MANAGERS,
  PROJECT_TEMPLATES,
  projectNameProblem,
  scaffoldCommand,
} from "../src/shared/project-templates"
import { check, finish, section } from "./harness"

section("every template has a command under every package manager")
for (const template of PROJECT_TEMPLATES) {
  for (const manager of PACKAGE_MANAGERS) {
    const command = scaffoldCommand(template.id, manager)
    check(
      `${template.id} with ${manager} aims at the current directory`,
      !!command && / \.( |$)/.test(command),
      command
    )
  }
}
check("an unknown template has none", scaffoldCommand("rails", "npm") === null)

section("the package manager is the runner and is named outright")
check(
  "next with pnpm",
  scaffoldCommand("next", "pnpm") ===
    "pnpm dlx create-next-app@latest . --use-pnpm"
)
check(
  "nuxt with bun",
  scaffoldCommand("nuxt", "bun") ===
    "bunx nuxi@latest init . --packageManager bun"
)
check(
  "vite passes its variant as the template",
  scaffoldCommand("vite-vue-ts", "npm") ===
    "npx create-vite@latest . --template vue-ts"
)

section("a name has to be one npm would take")
check("a plain name passes", projectNameProblem("my-app") === null)
check("dots and digits pass", projectNameProblem("app.v2_beta") === null)
check("empty is refused", projectNameProblem("") !== null)
check("capitals are refused", projectNameProblem("MyApp") !== null)
check("spaces are refused", projectNameProblem("my app") !== null)
check("a leading dot is refused", projectNameProblem(".app") !== null)
check("a separator is refused", projectNameProblem("a/b") !== null)
check("a backslash is refused", projectNameProblem("a\\b") !== null)
check("`..` is refused", projectNameProblem("..") !== null)
check("215 characters is refused", projectNameProblem("a".repeat(215)) !== null)

finish()
