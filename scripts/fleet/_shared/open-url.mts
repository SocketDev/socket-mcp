/*
 * @file One opener for every URL a fleet script hands to a human, and the only
 *   place the platform-opener ternary lives.
 *
 *   Why it exists: the platform opener alone lands the URL as a TAB in whatever
 *   browser window happens to be frontmost. On macOS `open <url>` hands the URL
 *   to the ALREADY RUNNING default browser, which appends a tab to the
 *   operator's own browsing session. A gate URL buried as tab 34 beside their
 *   real work is a URL nobody notices, and these URLs are the ones a run is
 *   blocked on.
 *
 *   A new window needs the BROWSER's own flag, not the opener's: `open`,
 *   `xdg-open`, and `start` have no new-window switch to pass. Chromium and
 *   Firefox both take `--new-window`, and a running instance answers it through
 *   its own process singleton, so invoking the binary directly opens a new
 *   window in the session the operator is already signed into. When no known
 *   browser binary is present the plain platform opener still runs, so a machine
 *   this does not recognize degrades to the previous behavior rather than
 *   failing to open anything.
 */

import { existsSync } from 'node:fs'
import process from 'node:process'
import { types } from 'node:util'

import { spawn } from '@socketsecurity/lib-stable/process/spawn/child'

/**
 * Browser binaries that accept `--new-window`, in the order to try them. Chrome
 * leads because the fleet's own durable npm profile is Chrome, so an operator
 * running these tools has it.
 */
export const NEW_WINDOW_BROWSERS: Readonly<Record<string, readonly string[]>> =
  {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Firefox.app/Contents/MacOS/firefox',
    ],
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/firefox',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  }

/**
 * The environment variable that points at a browser binary this does not know
 * about, so an operator with an unusual install is not stuck with a tab.
 */
export const BROWSER_BINARY_ENV_VAR = 'SOCKET_BROWSER_BINARY'

/**
 * Set by a suite that MOCKS the spawn seam and wants to assert on the opener's
 * invocation. Without it a test run never spawns at all, which is the safe
 * default; with it the call proceeds into whatever the suite mocked.
 */
export const ALLOW_SPAWN_ENV_VAR = 'SOCKET_OPEN_URL_ALLOW_SPAWN'

/**
 * True when the opener must NOT spawn: a test runner with no explicit opt-in.
 * Vitest sets `VITEST` in the worker and `NODE_ENV=test` covers the other
 * runners. Pure apart from the env read; exported for tests.
 */
export function shouldSkipSpawn(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const underRunner = Boolean(env['VITEST']) || env['NODE_ENV'] === 'test'
  return underRunner && !env[ALLOW_SPAWN_ENV_VAR]
}

/**
 * The platform's generic URL opener. It cannot ask for a new window, so it is
 * the fallback rather than the first choice.
 */
export function platformOpener(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'open'
  }
  return platform === 'win32' ? 'start' : 'xdg-open'
}

/**
 * The first `--new-window` capable browser present on this platform, or
 * undefined when none is. The env override wins outright.
 */
export function resolveNewWindowBrowser(
  options?:
    | {
        env?: Record<string, string | undefined> | undefined
        exists?: ((filePath: string) => boolean) | undefined
        platform?: NodeJS.Platform | undefined
      }
    | undefined,
): string | undefined {
  const opts = { __proto__: null, ...options } as NonNullable<typeof options>
  const env = opts.env ?? process.env
  const exists = opts.exists ?? existsSync
  const platform = opts.platform ?? process.platform
  const override = env[BROWSER_BINARY_ENV_VAR]
  if (typeof override === 'string' && override !== '') {
    return exists(override) ? override : undefined
  }
  const candidates = NEW_WINDOW_BROWSERS[platform] ?? []
  for (let i = 0, { length } = candidates; i < length; i += 1) {
    const candidate = candidates[i]!
    if (exists(candidate)) {
      return candidate
    }
  }
  return undefined
}

/**
 * The command and args that open `url`, preferring a NEW WINDOW. Pure, so the
 * choice is unit-testable without spawning a browser.
 */
export function buildOpenUrlInvocation(
  url: string,
  options?: Parameters<typeof resolveNewWindowBrowser>[0] | undefined,
): { args: string[]; command: string; newWindow: boolean } {
  const opts = { __proto__: null, ...options } as NonNullable<typeof options>
  const platform = opts.platform ?? process.platform
  const browser = resolveNewWindowBrowser(options)
  if (browser) {
    return { args: ['--new-window', url], command: browser, newWindow: true }
  }
  return { args: [url], command: platformOpener(platform), newWindow: false }
}

/**
 * Open `url` for the operator in a new browser window, fire-and-forget.
 *
 * Never throws and never waits: a run is not allowed to fail because a browser
 * did not launch, and every caller also prints the URL so the operator can open
 * it by hand. Answers whether a new window was requested, which is what a
 * caller reports when it wants to tell the operator where to look.
 */
export function openUrlInNewWindow(
  url: string,
  options?:
    | (Parameters<typeof resolveNewWindowBrowser>[0] & {
        spawn?: typeof spawn | undefined
      })
    | undefined,
): boolean {
  const opts = { __proto__: null, ...options } as NonNullable<typeof options>
  const platform = opts.platform ?? process.platform
  const spawnFn = opts.spawn ?? spawn
  const invocation = buildOpenUrlInvocation(url, options)
  // A unit test must never launch a real browser, and mocking the spawn seam
  // is not enough on its own to guarantee it. This module is reached through a
  // dynamic import several layers down, so a suite can mock
  // `node:child_process`, miss the lib-stable seam this actually uses, and open
  // a window on the developer's machine on every run — which is what happened
  // to npm-web-auth-flow's suite.
  //
  // Default-deny under a runner, with two ways through: an injected `spawn`,
  // since a caller passing its own spy is asking to observe the call, or the
  // ALLOW_SPAWN_ENV_VAR opt-in for a suite that mocked the seam and asserts on
  // the invocation. Forgetting both costs an assertion, never a stray window.
  if (!opts.spawn && shouldSkipSpawn()) {
    return invocation.newWindow
  }
  try {
    const child = spawnFn(invocation.command, invocation.args, {
      detached: true,
      // `start` is a cmd.exe builtin rather than an executable, and only the
      // fallback lane ever reaches it.
      shell: !invocation.newWindow && platform === 'win32',
      stdio: 'ignore',
    })
    // The 'error' listener goes on FIRST. An 'error' with no listener is an
    // unhandled throw that takes the whole run down, and a browser that would
    // not launch is never worth failing the operation the URL belongs to. The
    // emitter is `.process` on the lib's promise-backed child and the child
    // itself on a plain ChildProcess, so whichever exposes `on` gets it.
    const emitter = child.process ?? child
    if (typeof emitter?.on === 'function') {
      emitter.on('error', () => {})
    }
    // Then the promise rejection, which is how the lib reports a failed spawn.
    // `types.isPromise` rather than a `.catch` duck-type: the lib's child IS a
    // promise, and a test's fake child is a bare emitter, so the real check is
    // "is this thenable" and node already answers it.
    if (types.isPromise(child)) {
      child.catch(() => {
        // Best-effort: the printed URL is the fallback.
      })
    }
  } catch {
    // Best-effort: the printed URL is the fallback.
  }
  return invocation.newWindow
}
