Create a branch and open a pull request. Usage: `/dev:create-pr [path-to-task.md]`

## Steps

### 1. Gather context

Run these in parallel:

- `git status` — check for uncommitted changes
- `git log main..HEAD --oneline` — commits on current branch vs main
- `git diff main..HEAD --stat` — files changed
- If `$ARGUMENTS` is provided, read the task file at that path

### 2. Handle uncommitted changes

Check the result of `git status`:

- **If there are staged changes** (`Changes to be committed`) → run `/dev:code-commit` to commit them before proceeding.
- **If there are unstaged changes** (`Changes not staged`) → ask the user:
  > "You have unstaged changes. Stage and commit them before creating the PR? (y/n)"
  - If yes → `git add -p` is NOT automated; tell the user to stage what they want, then re-run `/dev:create-pr`.
  - If no → proceed with only the already-committed changes.
- **If the working tree is clean** → proceed directly.

### 3. Determine task ID and title

**If a task file was provided (`$ARGUMENTS`):**

- Extract **Task ID** from the line starting with `**Task ID**:` — the format is `CU-XXXXXX` (ClickUp ID).  
  Example: `**Task ID**: CU-86exyz12` → task ID is `86exyz12`
- Extract **Task title** from the `# Task:` heading line.

**If no task file (`$ARGUMENTS` is empty):**

- Task ID = none — proceed without it, do NOT ask the user for one.
- Derive a short title (max 6 words) from the git log/diff content.
- PR title will have no prefix, branch will have no `CU-` segment.

### 3. Create the branch

**Determine the branch prefix:**

If a task file is provided, read the task type from it (e.g. from the feature description or status tags).  
If no task file, infer from the git diff/log content.

| Type               | Prefix     | When                                 |
| ------------------ | ---------- | ------------------------------------ |
| New feature        | `feat`     | New functionality added              |
| Bug fix            | `fix`      | Fixing broken behavior               |
| Documentation      | `docs`     | Only docs/comments changed           |
| Chore / config     | `chore`    | Build, config, tooling, deps         |
| Refactor           | `refactor` | Code restructure, no behavior change |
| Style / formatting | `style`    | Lint, formatting, no logic change    |
| Test               | `test`     | Adding or fixing tests only          |

**Branch naming rules:**

- Format: `{prefix}/{slug}`
- `{slug}` = kebab-case version of the task title or derived title, lowercase, no special chars
- Max total branch name length: **50 characters** — truncate slug if needed
- With task ID: `{prefix}/CU-{task_id}-{slug}`
- Without task ID: `{prefix}/{slug}`

Run:

```bash
git checkout -b {branch-name}
```

If the branch already exists, switch to it instead.

### 4. Push the branch

```bash
git push -u origin {branch-name}
```

### 5. Draft the PR title

- **With task ID:** `[CU-{task_id}] {task title}`  
  Example: `[CU-86exyz12] Add room availability calendar view`
- **Without task ID:** A concise title (≤ 72 chars) describing the changes.

### 6. Draft the PR description

Use this exact template — fill every section from the git diff and task spec:

```markdown
## Summary

<!-- What changed and why — 3–5 bullet points -->

-
-
-

## Changes

<!-- Files / areas touched — brief, factual -->

| Area             | Change |
| ---------------- | ------ |
| `server/api/...` |        |
| `app/pages/...`  |        |

## Test checklist

### Unit tests

- [ ]
- [ ]

### E2E tests

- [ ]
- [ ]

## Notes

<!-- Anything reviewers should pay attention to, known limitations, follow-up tasks -->
```

Fill the checklist with concrete scenarios derived from the task's Requirements or from the diff if no task file.

### 7. Show draft and confirm

Print the branch name, PR title, and full description.  
Ask: **"Create this PR? (y/n)"**  
Wait for confirmation before proceeding.

### 8. Create the PR

```bash
gh pr create \
  --title "{PR title}" \
  --body "$(cat <<'EOF'
{PR description}
EOF
)" \
  --base main
```

**Hard rules:**

- Never add `Co-Authored-By` lines — not in the commit, not in the PR body.
- Never mention Claude, AI, or any tool attribution anywhere in the PR.

### 9. Output the PR URL

Print the URL returned by `gh pr create` so the user can open it directly.
