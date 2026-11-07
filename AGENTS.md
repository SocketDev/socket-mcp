# Repository instructions

- Use pnpm from the repository root.
- Run `pnpm run repo:check` and `pnpm test` after code changes.
- Keep generated build output out of commits.
- Use Conventional Commit messages.
- Run `pnpm run fmt` before `pnpm run lint`.
- Run `pnpm run check` for formatting, lint, type, build, manifest version, and content-scan checks.
- `pnpm install` points `core.hooksPath` at `.git-hooks/`. `pre-commit` scans staged files for secrets, personal paths, and private repository names; `commit-msg` requires a Conventional Commit subject and rejects AI attribution lines; `pre-push` runs `pnpm run repo:type`.
- Use `pnpm run fmt <paths...>` and `pnpm run lint <paths...>` for focused work.
