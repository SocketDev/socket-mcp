# Public-surface hygiene

The CLAUDE.md `### Public-surface hygiene` section gives the headline invariants. This file is the full ruleset with rationale, hook references, and bypass surface.

The rules apply even when hooks are not installed. They're invariants, not enforcement-dependent. Enforced by `.claude/hooks/fleet/{private-name-guard,public-surface-reminder,release-workflow-guard}/` and the rules below.

## Customer / company / internal names

- **Real customer / company names**: never write one into a commit, PR, issue, comment, or release note. Replace with `Acme Inc` or rewrite the sentence to not need the reference. No enumerated denylist exists; a denylist is itself a leak.
- **Private repos / internal project names**: never mention. Omit the reference entirely. Don't substitute "an internal tool"; the placeholder is a tell.

## Linear refs

Never put `SOC-123` / `ENG-456` / Linear URLs in code, comments, or PR text. Linear lives in Linear.

## Publish / release / build-release workflows

Never `gh workflow run|dispatch` against publish/release workflows. The user runs them manually. Bypass paths:

- `gh workflow run -f dry-run=true`: the workflow must declare a `dry-run:` input AND have no force-prod override set.
- `Allow workflow-dispatch bypass: <workflow>` typed verbatim: one phrase authorizes one dispatch.

`workflow_dispatch.inputs` keys are kebab-case (`dry-run`, `build-mode`); snake_case silently fails the bypass.

## Workflow YAML rules

- `uses: <action>@<40-char-sha>` lines need a trailing `# <tag> (YYYY-MM-DD)` comment so we can age-out stale pins (enforced by `.claude/hooks/fleet/workflow-uses-comment-guard/`).
- Workflow `run:` blocks with `gh ... --body "..."` break YAML on multi-line markdown; always `--body-file <path>` (enforced by `.claude/hooks/fleet/workflow-yaml-multiline-body-guard/`; bypass: `Allow workflow-yaml-multiline-body bypass`).
- Edits to `.github/workflows/*.y*ml` auto-lint via local `actionlint` (enforced by `.claude/hooks/fleet/actionlint-on-workflow-edit/`).

## `pull_request_target` is privileged

Runs in BASE-repo context with secrets. Never combine it with `actions/checkout` of fork head + a step that executes the checked-out code (enforced by `.claude/hooks/fleet/pull-request-target-guard/`). Full threat model + safer patterns in [`pull-request-target.md`](pull-request-target.md).

## No external issue/PR refs in commit messages or PR bodies

GitHub auto-links `<owner>/<repo>#<num>` and `https://github.com/<owner>/<repo>/(issues|pull)/<num>` mentions back to the target issue, spamming the maintainer with `added N commits that reference this issue` events.

- Only SocketDev-owned refs are allowed (`SocketDev/<repo>#<num>` is fine).
- For upstream maintainer issues, link them in _the PR description prose_ (which doesn't trigger backrefs from commits) or use the `[#1203](https://npmx.dev/...)` link form that omits the `owner/repo#` token.

Bypass: `Allow external-issue-ref bypass` (enforced by `.claude/hooks/fleet/no-external-issue-ref-guard/`).
