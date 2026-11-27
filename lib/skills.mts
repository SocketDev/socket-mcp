/**
 * @file MCP Skills (`io.modelcontextprotocol/skills`, Beta) for the local
 *   stdio and `--http` server. One skill, `watch-socket-alerts`, teaches an
 *   agent to turn this server's events into an automation. The SDK has no
 *   skills support yet, so `skills/list` and `skills/get` are custom handlers,
 *   and the skill's single file is served through `resources/read`.
 */
import { createHash } from 'node:crypto'

import { ProtocolError } from '@modelcontextprotocol/server'
import type { Server, StandardSchemaV1 } from '@modelcontextprotocol/server'
import { isPlainObject } from '@socketsecurity/lib-stable/objects/predicates'

export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
export const WATCH_SKILL_URI = 'skill://socket/watch-socket-alerts/SKILL.md'

const INVALID_PARAMS = -32_602
// The skill only changes when socket-mcp ships, so clients may cache it.
const CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: 'public' }

const FRONTMATTER = {
  name: 'watch-socket-alerts',
  description:
    'Set up an automation that reacts when Socket finds a new alert, or a new CVE with a Socket Certified Patch, in an organization. Use when the user wants to watch, monitor, or get notified about Socket alerts, vulnerabilities, malware, or patches.',
}

export const WATCH_SKILL_MD = `---
name: ${FRONTMATTER.name}
description: ${FRONTMATTER.description}
---

# Watch Socket alerts

This server publishes MCP events. An automation subscribes to one, and the
client runs the automation's action each time the event fires, even while
nobody is looking at the session.

## Events

| Event | Fires when | \`data\` |
| --- | --- | --- |
| \`socket.alert.created\` | A new alert appears in the org | \`org_slug\`, \`alert\` |
| \`socket.patch.available\` | A new CVE alert has a Socket Certified Patch | \`org_slug\`, \`alert\`, \`patches[]\` (\`uuid\`, \`purl\`) |

Both take \`org_slug\` (required) and \`severity\` (optional, comma-separated
subset of \`low,medium,high,critical\`). Existing alerts never fire: only alerts
that appear after the automation starts do.

## Steps

1. Get the organization slug. Call this server's \`organizations\` tool, or ask
   the user if they belong to several.
2. Pick the event. Use \`socket.patch.available\` when the user wants fixes
   they can apply now, and \`socket.alert.created\` for everything else.
3. Create the automation with the client's automation tool. In OpenCode:

   \`\`\`js
   automation_create({
     name: 'socket-alerts',
     trigger: {
       type: 'event',
       server: '<this server's configured name>',
       event: 'socket.patch.available',
       args: { org_slug: '<org>', severity: 'high,critical' },
     },
     action: {
       type: 'prompt',
       prompt: '<the prompt below>',
       to: { session: '<the current session id>' },
     },
   })
   \`\`\`

   OpenCode exposes the current session id as \`$OPENCODE_SESSION_ID\`.
4. Tell the user what you set up, and that deleting this session pauses the
   automation.

## Prompt for the action

For \`socket.alert.created\`:

> A new Socket alert arrived. Read the alert in the event data, check whether
> this project uses the affected package (manifests, lockfile, source), and
> propose a fix. Don't change files until I confirm.

For \`socket.patch.available\`:

> A Socket Certified Patch is available for a new CVE alert. Check that this
> project uses the affected package version, then preview the patch with
> \`socket-patch get <uuid> --dry-run\` using each uuid in the event's
> \`patches\`. Show me the preview and wait for my confirmation before applying
> it.

## Applying a certified patch

A certified patch backports the CVE fix into the exact version the project
already uses, so nothing is upgraded. Run these from the project root:

- \`socket-patch get <uuid> --dry-run\` previews the change.
- \`socket-patch get <uuid>\` applies it. Add \`--mode vendored\` to commit the
  patched package into the repo (\`.socket/vendor/\`) instead of pointing the
  lockfile at \`patch.socket.dev\`.
- Reinstall dependencies afterwards, then run \`socket-patch list\` to confirm.

If \`socket-patch\` isn't installed, use \`npx @socketsecurity/socket-patch\`.
Free patches cover critical CVEs and need no token. Other patches need a
Socket API token for an organization with the Patches add-on.
`

const WATCH_SKILL = {
  uri: WATCH_SKILL_URI,
  frontmatter: FRONTMATTER,
  resources: [
    {
      uri: WATCH_SKILL_URI,
      digest: `sha256:${createHash('sha256').update(WATCH_SKILL_MD).digest('hex')}`,
      size: Buffer.byteLength(WATCH_SKILL_MD),
    },
  ],
}

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

function assertSkillUri(uri: string): void {
  if (uri !== WATCH_SKILL_URI) {
    throw new ProtocolError(INVALID_PARAMS, `Unknown skill resource: ${uri}`)
  }
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
    () => ({ skills: [WATCH_SKILL], ...CACHE }),
  )

  server.setRequestHandler('skills/get', { params: uriParams() }, ({ uri }) => {
    assertSkillUri(uri)
    return { skill: WATCH_SKILL, ...CACHE }
  })

  server.setRequestHandler('resources/list', () => ({
    resources: [
      {
        uri: WATCH_SKILL_URI,
        name: FRONTMATTER.name,
        description: FRONTMATTER.description,
        mimeType: 'text/markdown',
      },
    ],
  }))

  server.setRequestHandler('resources/read', request => {
    assertSkillUri(request.params.uri)
    return {
      contents: [
        {
          uri: WATCH_SKILL_URI,
          mimeType: 'text/markdown',
          text: WATCH_SKILL_MD,
        },
      ],
    }
  })
}
