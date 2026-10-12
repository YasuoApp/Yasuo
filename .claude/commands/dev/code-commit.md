Create a git commit for staged changes following the project's commit convention (Conventional Commits).

## Steps

1. **Check what's staged** — run `git diff --cached` and `git status`.
2. **Refuse if nothing is staged** — tell the user to `git add` first.
3. **Pick the right type** for the change (see table below); add a scope if it clarifies the area touched.
4. **Draft the commit message** using the format:

   ```
   <type>[optional scope]: <description>

   [optional body: WHAT and WHY — not HOW]

   [optional footer(s)]
   ```

5. **Show the draft message** and ask for confirmation before committing.
6. **Commit** with:

   ```bash
   git commit -m "$(cat <<'EOF'
   <message here>
   EOF
   )"
   ```

7. **Verify** — run `git log --oneline -1` to confirm the commit was created.

---

## Commit Types

| Type       | Purpose                        |
| ---------- | ------------------------------ |
| `feat`     | New feature                    |
| `fix`      | Bug fix                        |
| `docs`     | Documentation only             |
| `style`    | Formatting/style (no logic)    |
| `refactor` | Code refactor (no feature/fix) |
| `perf`     | Performance improvement        |
| `test`     | Add/update tests               |
| `build`    | Build system / dependencies    |
| `ci`       | CI / config changes            |
| `chore`    | Maintenance / misc             |
| `revert`   | Revert a previous commit       |

---

## Rules

1. Format the subject as `<type>[optional scope]: <description>`.
2. Use the **imperative mood** in the description (e.g. "add", not "added" / "adds").
3. Keep the description concise — **under 72 characters**.
4. Do not end the description with a period.
5. Separate subject from body with a blank line.
6. Use the body to explain **what** and **why**, not how.
7. Reference issues in the footer when applicable (e.g. `Closes #123`).
8. One logical change per commit.

Reference: <https://www.conventionalcommits.org/>

---

## Breaking Changes

Indicate a breaking change with an exclamation mark after the type/scope, or with a `BREAKING CHANGE:` footer:

```
feat!: remove deprecated booking endpoint
```

```
feat: allow config to extend other configs

BREAKING CHANGE: `extends` key behavior changed
```

---

## Example messages

```
feat: add room availability calendar view

fix: prevent redirect loop when session expires

refactor: extract pagination logic into composable

build: add shadcn button and card components

docs: document /spec:create-task workflow

chore: remove unused booking helpers
```

Example with scope and body:

```
feat(booking): add multi-tenant room booking

Replaces the single-tenant booking flow with a per-org scope.
Required because JP client needs separate booking pools per
office location; the old global pool caused conflicts when two
offices booked the same room number.
```
