import {
  workflowInvocation,
  workflowRows,
  workflowSlug,
} from "../src/renderer/lib/workflows/invoke"
import type { Workflow } from "../src/shared/workflows"
import { check, finish, section } from "./harness"

/**
 * Calling a workflow from a chat: `@` and its slug at the head of a message.
 */

const workflow = (id: string, name: string): Workflow => ({
  id,
  name,
  createdAt: "",
  updatedAt: "",
})

const createPr = workflow("a1", "Create PR")
const deploy = workflow("b2", "Deploy (staging)")
const all = [createPr, deploy]

section("slugs")

check("lower case, dashed", workflowSlug(createPr) === "create-pr")
check("punctuation is a dash", workflowSlug(deploy) === "deploy-staging")
check(
  "accents drop, đ included",
  workflowSlug(workflow("c", "Tạo PR đầu tiên")) === "tao-pr-dau-tien"
)
check(
  "a name with nothing left is called by its id",
  workflowSlug(workflow("abcdef123", "!!!")) === "workflow-abcdef"
)

section("invocations")

{
  const found = workflowInvocation("@create-pr fix the login", all)
  check("the head word names the workflow", found?.workflow === createPr)
  check("what follows is the input", found?.input === "fix the login")
}
check(
  "the name alone has no input",
  workflowInvocation("@create-pr", all)?.input === ""
)
check(
  "the input keeps its lines",
  workflowInvocation("@create-pr one\ntwo", all)?.input === "one\ntwo"
)
check(
  "mid-sentence is a word, not a run",
  workflowInvocation("please @create-pr now", all) === null
)
check(
  "a path is not a workflow",
  workflowInvocation("@src/main/ipc.ts why", all) === null
)
check(
  "a near miss is not a run",
  workflowInvocation("@create-prs", all) === null
)

section("menu rows")

{
  const [row] = workflowRows([createPr])
  check("the slug is inserted", row?.label === "create-pr")
  check("the name is under it", row?.detail === "Create PR")
  check("it is a workflow row", row?.kind === "workflow")
}

finish()
