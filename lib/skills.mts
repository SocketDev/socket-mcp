/**
 * @file MCP Skills (`io.modelcontextprotocol/skills`, Beta) for the local
 *   stdio and `--http` server. Two skills, each a single `SKILL.md`:
 *   `watch-socket-alerts` turns this server's events into an automation, and
 *   `apply-socket-patch` applies a Socket Certified Patch. The SDK has no
 *   skills support yet, so `skills/list` and `skills/get` are custom handlers,
 *   and each skill's file is served through `resources/read`.
 */
import { createHash } from 'node:crypto'

import { ProtocolError } from '@modelcontextprotocol/server'
import type { Server, StandardSchemaV1 } from '@modelcontextprotocol/server'
import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const WATCH_SKILL_URI = 'skill://socket/watch-socket-alerts/SKILL.md'
export const PATCH_SKILL_URI = 'skill://socket/apply-socket-patch/SKILL.md'

const INVALID_PARAMS = -32_602
// Skills only change when socket-mcp ships, so clients may cache them.
const CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: 'public' }

const WATCH_DESCRIPTION =
  'Set up an automation that reacts when Socket finds a new alert, or a new CVE with a Socket Certified Patch, in an organization. Use when the user wants to watch, monitor, or get notified about Socket alerts, vulnerabilities, malware, or patches.'

const WATCH_BODY = `# Watch Socket alerts

This server publishes MCP events. An automation subscribes to one, and the
client runs the automation's action each time the event fires, even while
nobody is looking at the session.

## Events

| Event | Fires when | \`data\` |
| --- | --- | --- |
| \`socket.alert.created\` | A new alert appears in the org | \`org_slug\`, \`alert\` |
| \`socket.patch.available\` | A new CVE alert has a Socket Certified Patch | \`org_slug\`, \`alert\`, \`patches[]\` (\`uuid\`, \`purl\`) |

Arguments for both:

| Argument | Required | Meaning |
| --- | --- | --- |
| \`org_slug\` | yes | The Socket organization |
| \`repo_slug\` | no | Comma-separated Socket repo slugs. Without it, the watch covers every repo in the org |
| \`package\` | no | Only alerts for this package name |
| \`severity\` | no | Comma-separated subset of \`low,medium,high,critical\` |

Existing alerts never fire: only alerts that appear after the automation
starts do. \`socket.patch.available\` also fires when an existing alert gains a
patch.

## Steps

1. Get the organization slug. Call this server's \`organizations\` tool, or ask
   the user if they belong to several.
2. Scope the watch to the current project. Pass \`repo_slug\`: the Socket repo
   slug is usually the repository name, from the git remote or, without one,
   the project directory's name. Watch the whole org only if the user asks
   for it, and say so when you confirm.
3. Pick the event. Use \`socket.patch.available\` when the user wants fixes
   they can apply now, and \`socket.alert.created\` for everything else. Pass
   \`severity\` or \`package\` only when the user names one, with exactly the
   values they named: "high" is \`high\`, not \`high,critical\`.
4. Create the automation with the client's automation tool. In OpenCode:

   \`\`\`js
   automation_create({
     name: 'socket-alerts',
     trigger: {
       type: 'event',
       server: '<this server's configured name>',
       event: 'socket.patch.available',
       args: { org_slug: '<org>', repo_slug: '<repo>' },
     },
     action: {
       type: 'prompt',
       prompt: '<the prompt below>',
       to: { session: '<the current session id>' },
     },
   })
   \`\`\`

   OpenCode exposes the current session id as \`$OPENCODE_SESSION_ID\`.
5. Tell the user what you set up, including the repo it watches, and that
   deleting this session pauses the automation.

## Prompt for the action

For \`socket.alert.created\`:

> A new Socket alert arrived. Read the alert in the event data, check whether
> this project uses the affected package (manifests, lockfile, source), and
> propose a fix. Don't change files until I confirm.

For \`socket.patch.available\`:

> A Socket Certified Patch is available for a new CVE alert. Load the
> apply-socket-patch skill, check that this project uses the affected package
> version, and preview each patch in the event's \`patches\`. Show me the
> preview and wait for my confirmation before applying it.

To apply a patch, follow the \`apply-socket-patch\` skill from this server.
`

const PATCH_DESCRIPTION =
  'Find, preview, apply, verify, and roll back Socket Certified Patches with the socket-patch CLI. A certified patch backports a CVE fix into the exact dependency version in use, so nothing is upgraded. Use when the user wants to patch a CVE, GHSA, or package without upgrading it, or acts on a socket.patch.available event.'

const PATCH_BODY = `# Apply a Socket Certified Patch

A Socket Certified Patch removes a CVE from a dependency without changing its
version. Run every command from the project root. If \`socket-patch\` isn't
installed, use \`npx @socketsecurity/socket-patch\`.

## Access

- Free patches cover critical CVEs. They need no token: the CLI reads them
  from Socket's public patch API.
- Other patches need \`SOCKET_API_TOKEN\` for an organization with the Patches
  add-on.

## 1. Find the patch

- From a \`socket.patch.available\` event: use each \`uuid\` in \`patches\`.
- \`socket-patch get <CVE | GHSA | purl | uuid | package> --dry-run\` targets
  one advisory or package.
- \`socket-patch scan --dry-run\` lists every available patch for the project.

\`--dry-run\` changes nothing. \`scan --json\` without \`--dry-run\` applies
patches, so never use it to preview.

Before applying, confirm the project really uses the affected version: check
the manifest, the lockfile, and \`node_modules\` (or the ecosystem's
equivalent).

## 2. Pick a mode

- **Vendored** (\`--mode vendored\`): commits the patched package under
  \`.socket/vendor/\`. Installs need nothing from Socket. Prefer it with pnpm 11
  or later.
- **Hosted** (the default for a project with no patches): points the lockfile
  at \`patch.socket.dev\`. With pnpm 11 or later it also writes
  \`trustLockfile: true\` to \`pnpm-workspace.yaml\`, which turns off pnpm's
  lockfile re-verification for every entry. Mention that before using it.

A project keeps the mode it already uses unless you pass \`--mode\`.

## 3. Apply and reinstall

\`\`\`sh
socket-patch get <uuid> --mode vendored
rm -rf node_modules && pnpm install   # or the project's install command
\`\`\`

Reinstall from a clean \`node_modules\`: an existing install can keep the
unpatched files. Never rebuild the lockfile (for example \`pnpm clean
--lockfile\`), because that drops the patch and reinstalls the vulnerable
version.

Commit what the CLI reports, together: \`.socket/vendor/\`, the lockfile,
\`package.json\`, and \`pnpm-workspace.yaml\` when it was written.

## 4. Verify

- \`socket-patch list\` shows the patch, its mode, and the files it changed.
- \`socket-patch vex\` should report the CVE as \`not_affected\`.
- If you test the exploit, use the advisory's real payload, and show that it
  succeeds on the unpatched version first. A check that passes on both
  versions proves nothing.

## 5. Roll back

\`socket-patch rollback\` restores the upstream packages. In vendored mode,
\`socket-patch vendor --revert\` also works. Reinstall afterwards.
`

function defineSkill(name: string, description: string, body: string) {
  const uri = `skill://socket/${name}/SKILL.md`
  const text = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`
  return {
    text,
    entry: {
      uri,
      frontmatter: { name, description },
      resources: [
        {
          uri,
          digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
          size: Buffer.byteLength(text),
        },
      ],
    },
  }
}

const SKILLS = [
  defineSkill('watch-socket-alerts', WATCH_DESCRIPTION, WATCH_BODY),
  defineSkill('apply-socket-patch', PATCH_DESCRIPTION, PATCH_BODY),
]

function uriParams(): StandardSchemaV1<unknown, { uri: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'socket-mcp',
      validate(value) {
        const uri = isPlainObject(value) ? value['uri'] : undefined
        return typeof uri === 'string'
          ? { value: { uri } }
          : { issues: [{ message: 'uri must be a string' }] }
      },
    },
  }
}

function findSkill(uri: string) {
  const skill = SKILLS.find(s => s.entry.uri === uri)
  if (!skill) {
    throw new ProtocolError(INVALID_PARAMS, `Unknown skill resource: ${uri}`)
  }
  return skill
}

/**
 * Advertise the skills extension (plus `resources`, which the spec requires
 * because skill files are resources) and register its handlers.
 */
export function registerSkillHandlers(server: Server): void {
  server.registerCapabilities({
    resources: {},
    extensions: { [SKILLS_EXTENSION]: {} },
  })

  server.setRequestHandler(
    'skills/list',
    {
      params: {
        '~standard': {
          version: 1,
          vendor: 'socket-mcp',
          validate: value => ({ value }),
        },
      },
    },
    () => ({ skills: SKILLS.map(s => s.entry), ...CACHE }),
  )

  server.setRequestHandler(
    'skills/get',
    { params: uriParams() },
    ({ uri }) => ({
      skill: findSkill(uri).entry,
      ...CACHE,
    }),
  )

  server.setRequestHandler('resources/list', () => ({
    resources: SKILLS.map(({ entry }) => ({
      uri: entry.uri,
      name: entry.frontmatter.name,
      description: entry.frontmatter.description,
      mimeType: 'text/markdown',
    })),
  }))

  server.setRequestHandler('resources/read', request => {
    const { entry, text } = findSkill(request.params.uri)
    return { contents: [{ uri: entry.uri, mimeType: 'text/markdown', text }] }
  })
}
