/**
 * @file The socket-gate hook's event-to-decision contract, driven in-process.
 *   `runHook` takes the descriptor to read the event from and the `fetch` the
 *   MCP round trip goes through, so a case hands over a scratch file and a
 *   stub instead of a pipe and the network. Nothing here leaves the process.
 */

import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { safeDelete } from '@socketsecurity/lib-stable/fs/safe'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

import { main, readHookEvent, runHook } from '../../hooks/socket-gate/index.mts'

const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'socket-gate-'))

let nextFile = 0

afterAll(async () => {
  await safeDelete(scratchDir)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// A read-only descriptor onto a scratch file holding `contents`.
function eventFd(contents: string): number {
  nextFile += 1
  const file = path.join(scratchDir, `event-${nextFile}.json`)
  writeFileSync(file, contents)
  return openSync(file, 'r')
}

// A write-only descriptor — `readFileSync` on it fails, which is the
// "stdin is not readable" case.
function unreadableFd(): number {
  nextFile += 1
  return openSync(path.join(scratchDir, `unreadable-${nextFile}`), 'w')
}

function bashEvent(toolInput: unknown): string {
  return JSON.stringify({
    session_id: 's',
    tool_name: 'Bash',
    tool_input: toolInput,
  })
}

// The MCP round trip checkPackage makes: initialize (must answer an
// mcp-session-id header) then the depscore tool call carrying `scoreText`.
function stubFetch(scoreText: string): typeof fetch {
  let calls = 0
  return () => {
    calls += 1
    if (calls === 1) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the stub answers only the members the hook reads off a Response.
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'mcp-session-id': 'stub-session' }),
        text: () => Promise.resolve(''),
      } as unknown as Response)
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the stub answers only the members the hook reads off a Response.
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () =>
        Promise.resolve({
          result: { content: [{ type: 'text', text: scoreText }] },
        }),
    } as unknown as Response)
  }
}

function throwingFetch(): typeof fetch {
  return () => Promise.reject(new Error('stubbed transport failure'))
}

interface HookRun {
  decision: Record<string, unknown>
  stderr: string
}

// Run one event to completion and read back what the hook wrote to each
// stream. stdout carries the permission decision; stderr carries fail-open
// diagnostics.
async function drive(fd: number, fetchImpl: typeof fetch): Promise<HookRun> {
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true)
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true)
  try {
    await runHook(fd, fetchImpl)
  } finally {
    closeSync(fd)
  }
  const written = stdout.mock.calls.map(call => String(call[0])).join('')
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook's stdout is untyped JSON; the fields callers read are asserted immediately.
  const parsed = JSON.parse(written) as {
    hookSpecificOutput: Record<string, unknown>
  }
  return {
    decision: parsed.hookSpecificOutput,
    stderr: stderr.mock.calls.map(call => String(call[0])).join(''),
  }
}

// A fetch that must never be called — the case is expected to decide before
// the MCP round trip.
const unusedFetch = stubFetch('supplyChain: 100')

describe('readHookEvent', () => {
  test('reads the event off the descriptor', () => {
    const fd = eventFd('{"tool_name":"Bash"}')
    try {
      expect(readHookEvent(fd)).toBe('{"tool_name":"Bash"}')
    } finally {
      closeSync(fd)
    }
  })

  test('reads an unreadable descriptor as an empty event', () => {
    const fd = unreadableFd()
    try {
      expect(readHookEvent(fd)).toBe('')
    } finally {
      closeSync(fd)
    }
  })
})

describe('socket-gate hook decisions', () => {
  test('allows when the event is empty', async () => {
    const run = await drive(eventFd(''), unusedFetch)
    expect(run.decision).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    })
  })

  test('allows when the event descriptor is not readable', async () => {
    const run = await drive(unreadableFd(), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows when the event is not JSON', async () => {
    const run = await drive(eventFd('this is not json'), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows any tool that is not Bash', async () => {
    const event = JSON.stringify({
      session_id: 's',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    })
    const run = await drive(eventFd(event), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows a Bash event whose tool_input carries no command', async () => {
    const run = await drive(
      eventFd(bashEvent({ description: 'no command key' })),
      unusedFetch,
    )
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows a Bash event with no tool_input at all', async () => {
    const event = JSON.stringify({ session_id: 's', tool_name: 'Bash' })
    const run = await drive(eventFd(event), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows a Bash event whose command is not a string', async () => {
    const run = await drive(eventFd(bashEvent({ command: 42 })), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('allows a Bash command that installs nothing', async () => {
    const run = await drive(
      eventFd(bashEvent({ command: 'git status --short' })),
      unusedFetch,
    )
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('reads the string form of tool_input', async () => {
    // Some harness versions hand the command over as a bare string rather
    // than a { command } record.
    const run = await drive(eventFd(bashEvent('ls -la')), unusedFetch)
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('scans an install passed as a bare tool_input string', async () => {
    const run = await drive(
      eventFd(bashEvent('npm install left-pad')),
      stubFetch('supplyChain: 88'),
    )
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
  })

  test('denies an install whose supply chain score is under the threshold', async () => {
    const run = await drive(
      eventFd(bashEvent({ command: 'npm install browserlist' })),
      stubFetch('supplyChain: 5'),
    )
    expect(run.decision['permissionDecision']).toBe('deny')
    expect(run.decision['permissionDecisionReason']).toBe(
      'Socket blocked "browserlist" (npm): supply chain score is 5 (threshold 20).\n\nReview: https://socket.dev/npm/package/browserlist',
    )
    expect(run.stderr).toBe('')
  })

  test('allows an install whose supply chain score clears the threshold', async () => {
    const run = await drive(
      eventFd(bashEvent({ command: 'pip install requests' })),
      stubFetch('supplyChain: 91'),
    )
    expect(run.decision).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    })
    expect(run.stderr).toBe('')
  })

  test('fails open and reports on stderr when the Socket check errors', async () => {
    const run = await drive(
      eventFd(bashEvent({ command: 'cargo add serde' })),
      throwingFetch(),
    )
    // The install is allowed through — the gate is advisory, not a hard
    // block — and the failure is surfaced on stderr, never on stdout.
    expect(run.decision).toMatchObject({ permissionDecision: 'allow' })
    expect(run.stderr).toMatch(
      /socket-gate: check failed for cargo\/serde, failing open: stubbed transport failure/,
    )
  })
})

describe('runHook fails open on an event main cannot handle', () => {
  // `JSON.parse('null')` is valid JSON that is not an object, so reading
  // `tool_name` off it throws past every try/catch inside main.
  test('main rejects on a null event', async () => {
    const fd = eventFd('null')
    try {
      await expect(main(fd, unusedFetch)).rejects.toThrow(TypeError)
    } finally {
      closeSync(fd)
    }
  })

  test('runHook turns that rejection into an allow', async () => {
    const run = await drive(eventFd('null'), unusedFetch)
    expect(run.decision).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
    })
  })
})
