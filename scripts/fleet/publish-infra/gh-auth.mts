/*
 * @file One gh-auth preflight for every publish flow. `npm:`, `cargo:` and
 *   `github:` all reach GitHub before they reach a registry — a release is
 *   tagged, a release object is cut, a workflow is dispatched — so all three
 *   need an authenticated `gh` and all three used to discover that partway
 *   through, after a build had already run.
 *
 *   The preflight is a READ. It never logs anyone in on its own: `gh auth
 *   login` opens a browser and takes a device code, which is the operator's to
 *   drive, and a script that silently re-auths is a script that can be made to
 *   auth as somebody else. When the state is wrong this reports what is wrong
 *   and the one command that fixes it.
 *
 *   Token hygiene rides along, because the shape of the token matters as much
 *   as its presence (docs/agents.md/fleet/gh-token-hygiene.md): the fleet
 *   stores tokens in the OS keychain, never a plaintext config, and keeps the
 *   `workflow` scope OFF by default so a stray token cannot rewrite CI. A flow
 *   that dispatches a workflow is the one case that needs it, and it asks by
 *   name rather than the preflight granting it to everyone.
 */

import { spawnSync } from '@socketsecurity/lib-stable/process/spawn/child'

export interface GhAuthState {
  // Authenticated at all. Everything else is only meaningful when true.
  readonly authenticated: boolean
  // The login gh reports, for the "signed in as somebody else" case.
  readonly account: string | undefined
  // Stored in the OS keychain rather than a plaintext config file.
  readonly keyring: boolean
  // Scopes gh reports on the active token.
  readonly scopes: readonly string[]
}

/**
 * Parse `gh auth status` output. Pure, so the decision below is testable
 * without a gh install or a live token.
 *
 * Gh prints a human report rather than JSON here, so this reads the three
 * facts the fleet cares about and ignores the rest: whether a login is
 * reported at all, whether the token lives in the keyring, and the scope list.
 */
export function parseGhAuthStatus(output: string): GhAuthState {
  const account = /Logged in to \S+ account (?<account>\S+)/.exec(output)
    ?.groups?.['account']
  const scopeLine =
    /Token scopes:\s*(?<scopes>.*)/.exec(output)?.groups?.['scopes'] ?? ''
  const scopes = scopeLine
    .split(',')
    // gh quotes each scope; strip one leading and one trailing quote.
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  return {
    account,
    authenticated: !!account,
    keyring: /keyring/i.test(output),
    scopes,
  }
}

/**
 * What is wrong with `state` for a flow that needs `requiredScopes`, as
 * operator-readable lines, or an empty list when nothing is wrong. Pure.
 */
export function ghAuthProblems(
  state: GhAuthState,
  requiredScopes: readonly string[] = [],
): string[] {
  if (!state.authenticated) {
    return ['not signed in to GitHub']
  }
  const problems: string[] = []
  if (!state.keyring) {
    // A token in a plaintext config is readable by anything on the machine,
    // which is the whole reason the fleet requires the keyring.
    problems.push('the token is not stored in the OS keyring')
  }
  for (const scope of requiredScopes) {
    if (!state.scopes.includes(scope)) {
      problems.push(`the token is missing the ${scope} scope`)
    }
  }
  return problems
}

/**
 * The four-ingredient block for a failed preflight, naming the flow so an
 * operator knows which command stopped and why. Pure.
 */
export function formatGhAuthFailure(config: {
  flow: string
  problems: readonly string[]
  requiredScopes: readonly string[]
}): string {
  const cfg = { __proto__: null, ...config } as typeof config
  const scopeFlag = cfg.requiredScopes.length
    ? ` --scopes ${cfg.requiredScopes.join(',')}`
    : ''
  return [
    `${cfg.flow} needs an authenticated gh before it starts.`,
    `  Where: the gh auth preflight, before anything is built or published.`,
    `  Saw vs. wanted: ${cfg.problems.join('; ')}; wanted a keyring-stored login${
      cfg.requiredScopes.length
        ? ` carrying ${cfg.requiredScopes.join(', ')}`
        : ''
    }.`,
    `  Fix: gh auth login --hostname github.com --git-protocol ssh${scopeFlag}`,
  ].join('\n')
}

/**
 * Read the current gh auth state. Returns an unauthenticated state when gh is
 * absent or errors, so a caller decides what to do rather than crashing here.
 */
export function readGhAuthState(): GhAuthState {
  const run = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  // gh writes the report to stderr on some versions and stdout on others.
  const output = `${String(run.stdout ?? '')}\n${String(run.stderr ?? '')}`
  return parseGhAuthStatus(output)
}

/**
 * Throw with the four-ingredient block unless gh is authenticated the way
 * `flow` needs. The one call every publish flow makes first.
 */
export function assertGhAuth(config: {
  flow: string
  requiredScopes?: readonly string[] | undefined
}): void {
  const cfg = { __proto__: null, ...config } as typeof config
  const requiredScopes = cfg.requiredScopes ?? []
  const problems = ghAuthProblems(readGhAuthState(), requiredScopes)
  if (problems.length) {
    throw new Error(
      formatGhAuthFailure({ flow: cfg.flow, problems, requiredScopes }),
    )
  }
}
