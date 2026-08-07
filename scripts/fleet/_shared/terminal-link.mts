#!/usr/bin/env node
/*
 * @file OSC 8 terminal hyperlinks, and the click-to-copy URL a gate's lane A
 *   uses so the operator never retypes an authorization phrase.
 *
 *   Why this exists rather than socket-lib's `links/create`: that helper colors
 *   link text and says so in its own docstring ("colors the text but does not
 *   create clickable hyperlinks"). Nothing in the fleet emitted OSC 8 before
 *   this module.
 *
 *   Copy, never submit — the security property this module is built around.
 *   A `url` handler is invokable by ANY local process: `open x-socketsecurity--fleet://...`
 *   from an agent is indistinguishable from a human click. If the handler
 *   submitted, an agent could mint a user-role turn carrying an authorization
 *   phrase and defeat every provenance guard in the fleet at once. So the
 *   handler copies it to the clipboard and stops. The human's Enter keystroke stays the
 *   provenance anchor, which is exactly the property
 *   push-protected-branch-guard depends on. `COPY_ACTION` is the only action
 *   this module can spell; there is deliberately no submit action to reach.
 */

import process from 'node:process'

/*
 * The URL scheme the fill handler registers. Namespaced `x-` per RFC 6335's
 * unregistered-scheme convention, and `wh` for wheelhouse, matching the
 * `wh:` HTML-comment marker namespace.
 */
export const FLEET_URL_SCHEME = 'x-socketsecurity--fleet'

/*
 * The ONLY action. Adding a submit action here would silently convert every
 * existing gate into an agent-reachable self-authorization, so the absence of
 * one is load-bearing and belongs in review.
 */
export const COPY_ACTION = 'copy'

const OSC = '\u001B]'
const ST = '\u0007'

/*
 * Terminals that render OSC 8. `TERM_PROGRAM` is the reliable signal on macOS;
 * `WT_SESSION` covers Windows Terminal. VS Code's integrated terminal and
 * Apple Terminal are deliberately ABSENT — Apple Terminal renders the escape
 * as visible garbage, which is worse than plain text.
 */
const HYPERLINK_TERM_PROGRAMS = new Set([
  'ghostty',
  'Hyper',
  'iTerm.app',
  'kitty',
  'rio',
  'WezTerm',
])

/**
 * True when the current terminal renders OSC 8 hyperlinks.
 *
 * `FORCE_HYPERLINK` overrides in both directions so a caller can test either
 * branch, and so an operator on an unlisted-but-capable terminal can opt in
 * without a code change.
 */
export function supportsHyperlinks(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const forced = env['FORCE_HYPERLINK']
  if (forced !== undefined && forced !== '') {
    return forced !== '0' && forced.toLowerCase() !== 'false'
  }
  if (env['NO_HYPERLINK'] !== undefined) {
    return false
  }
  if (env['WT_SESSION']) {
    return true
  }
  const program = env['TERM_PROGRAM']
  return program !== undefined && HYPERLINK_TERM_PROGRAMS.has(program)
}

/**
 * `text` as an OSC 8 hyperlink to `url`, or plain `text` when the terminal
 * would show the escape rather than render it.
 *
 * Degrading to plain text is the correct fallback for a gate: lane A must stay
 * copy-pasteable verbatim, so a terminal without hyperlink support loses the
 * click and keeps the phrase.
 */
export function osc8Link(
  text: string,
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!supportsHyperlinks(env)) {
    return text
  }
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`
}

/**
 * The click-to-copy URL for `text`.
 *
 * The text rides in the URL because the handler must place it on the clipboard
 * verbatim and has no session to look it up from. That is safe precisely
 * BECAUSE filling is all it can do: the URL carries no authority, only text.
 * Encoded with `encodeURIComponent` so a phrase containing spaces or
 * punctuation survives.
 */
export function copyUrl(text: string): string {
  return `${FLEET_URL_SCHEME}://${COPY_ACTION}?text=${encodeURIComponent(text)}`
}

/**
 * Lane A's rendering of an authorization phrase: clickable where supported,
 * verbatim everywhere.
 *
 * Callers pass the phrase ALONE, never a sentence containing it. A gate's lane
 * A is copy-pasteable by rule, so the link text has to be exactly what the
 * operator would otherwise type.
 */
export function toCopyLink(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return osc8Link(text, copyUrl(text), env)
}

/*
 * The in-session run prefix. Typing `! <cmd>` in the Claude Code prompt runs
 * the command in THIS session, so its output lands in the conversation instead
 * of a detached terminal the agent cannot read.
 */
export const RUN_PREFIX = '! '
