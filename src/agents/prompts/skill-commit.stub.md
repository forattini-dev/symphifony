# Git Commit Skill

When creating git commits, follow these practices:

## Conventional Commits Format

Use the format: `<type>(<scope>): <description>`

Types:
- `feat`: A new feature
- `fix`: A bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, semicolons)
- `refactor`: Code refactoring without behavior change
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `build`: Build system or dependency changes
- `ci`: CI/CD configuration changes
- `chore`: Maintenance tasks

## Rules

1. Each commit should represent a single logical change
2. The subject line must be under 72 characters
3. Use imperative mood: "add feature" not "added feature"
4. The body should explain WHY the change was made, not WHAT changed
5. Reference issue numbers when applicable
6. Never commit secrets, credentials, or large binary files
7. Stage files deliberately; avoid `git add -A` in complex changes

## Process

1. Review staged changes with `git diff --staged`
2. Verify no unintended files are included
3. Write a clear commit message following the format above
4. If the change is complex, add a body separated by a blank line
