# parallel-agent-removal-reminder

Stop hook. At turn-end, lists files THIS session previously **Read** that
have since vanished or moved on disk — without this session running `rm`
/ `git rm` / `safeDelete` / `unlink` / `git mv` on them. That asymmetry
(I read it, I didn't delete it, it's gone) is the fingerprint of another
Claude session sharing the same `.git/` removing or moving files
mid-flight. Informational by default; **loud** when other foreign-dirty
signals confirm a parallel agent.

## When it fires

For every absolute path in this session's transcript with a `Read` /
`Edit` / `Write` / `NotebookEdit` `file_path`:

- the path no longer exists on disk, AND
- this session did not run a removal verb (`rm`, `git rm`, `git mv`,
  `safeDelete`, `safeRm`, `unlink`) on the path or any ancestor, AND
- the path is inside `CLAUDE_PROJECT_DIR` (vanished `/tmp/` scratch is
  ignored).

If `listForeignDirtyPaths > 0` also fires, the message escalates to a
LOUD warning with PAUSE WORK directive.

## Why

Incident 2026-06-04, socket-lib: a session re-read
`src/paths/packages.ts` to add `findUpPackageJson`, found the file
already contained the function (in a broken-imports, mid-flight state)
because another agent had added it elsewhere. The existing parallel-agent
hooks (`edit-guard`, `staging-guard`, `on-stop-reminder`) covered Writes,
git ops, and Stop-time dirty paths but NOT the removal-of-read-files
signal. This hook closes that gap.

## Companion hooks

- `parallel-agent-edit-guard` — PreToolUse block on Writes to foreign
  files.
- `parallel-agent-staging-guard` — PreToolUse block on destructive git
  ops while foreign paths exist.
- `parallel-agent-on-stop-reminder` — Stop reminder for dirty foreign
  paths.

This hook is the fourth surface in the family: the **read-then-gone**
detector. The three together cover write/git/dirty/vanished.

## Bypass

No bypass — it's a reminder (exit 0), not a block.

## Related

- CLAUDE.md → "Parallel Claude sessions".
- `docs/claude.md/fleet/parallel-claude-sessions.md`.
