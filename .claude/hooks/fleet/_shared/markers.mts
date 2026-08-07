/*
 * @file Canonical opt-out marker handling shared across hooks. The fleet uses
 *   oxlint's own directive spelling - `// oxlint-disable-line socket/<rule>` for
 *   the line it sits on, `// oxlint-disable-next-line socket/<rule>` on its own
 *   line for the line below - so one grammar covers the lint rules and the
 *   hook/scanner checks alike, and nobody has to remember a second one. The
 *   older `socket-lint: allow` spelling is gone, not deprecated.
 *
 *   The GRAMMAR and the name table live in `suppression-rules.mts`, which the
 *   git-hook scanners read too. This module owns what that one does not: the
 *   PLACEMENT questions oxlint answers by position rather than by text — which
 *   line a directive covers, and when one is sitting somewhere it cannot work.
 *   Two copies of the grammar would drift into disagreeing about whether a line
 *   was waived, which is the footgun the "marker name was logger, now it's
 *   console" episode already demonstrated once.
 */

import {
  suppressionWaivesNextLine,
  suppressionWaivesOwnLine,
} from './suppression-rules.mts'

/**
 * True when `line` carries a suppression waiving `rule`.
 *
 * A thin pass-through to the shared reader, kept so a Claude-hook caller reads
 * grammar and placement from one import instead of two.
 */
export function lineIsSuppressed(
  line: string,
  rule?: string | undefined,
): boolean {
  return rule !== undefined && suppressionWaivesOwnLine(line, rule)
}

// A line that is ONLY a `-next-line` directive — the directive right after the
// comment opener, optionally a `-- reason` tail, optionally a block-comment
// close. Such a line covers the LINE BELOW it, so a long pragma can sit above
// the code it excuses instead of trailing it. Prose that merely mentions the
// directive mid-sentence has text before it and does not match.
//
// Answers PLACEMENT only. Which rules a directive names is
// `suppression-rules.mts`'s question, so the rule token is not captured here.
export const OXLINT_DISABLE_NEXT_LINE_RE: RegExp =
  /^\s*(?:#|<!--|\/\*|\/\/)\s*oxlint-disable-next-line(?:\s+socket\/(?:[\w-]+))?(?:\s*(?:-->|\*\/)|\s+--.*)?\s*$/

/**
 * A `-next-line` directive sitting at the END of a line of code. It reads like
 * a same-line opt-out and silently is not one: oxlint applies it to the line
 * BELOW, so the line it trails stays unsuppressed and the line under it gets
 * excused by accident. The same-line spelling is `oxlint-disable-line`.
 *
 * Upstream defines `-next-line` as "the line following the comment" and `-line`
 * as "the current line", so the first belongs on its own line above and the
 * second trails: https://oxc.rs/docs/guide/usage/linter/ignore-comments.html.
 *
 * Exported so a check can find these mechanically rather than by review - the
 * marker migration produced them in bulk, which is exactly the shape that hides
 * in a 300-file diff.
 *
 * @example
 *   // Correct: the directive is alone on its line, so it covers the line below.
 *   // oxlint-disable-next-line no-console
 *   console.log('excused')
 *
 *   // Correct: the directive trails, so it covers the line it sits on.
 *   console.log('excused') // oxlint-disable-line no-console
 *
 *   // WRONG, and what this pattern finds: reads as a same-line waiver, but the
 *   // console.log stays flagged and the NEXT line is excused by accident.
 *   console.log('still flagged') // oxlint-disable-next-line no-console
 */
export const MISPLACED_TRAILING_NEXT_LINE_RE: RegExp =
  /\S[^\n]*?(?:#|<!--|\/\*|\/\/)\s*oxlint-disable-next-line\b/

/**
 * True when `line` is code with a `-next-line` directive trailing it, which
 * suppresses the wrong line.
 */
export function hasMisplacedTrailingDirective(line: string): boolean {
  return MISPLACED_TRAILING_NEXT_LINE_RE.test(line)
}

/**
 * True when `lines[index]` is suppressed for `rule` — by a marker on the line
 * itself, or by a marker-only comment line directly above it. Line loops
 * should prefer this over `lineIsSuppressed` so both placements work.
 */
export function suppressionCoversLine(
  lines: readonly string[],
  index: number,
  rule?: string | undefined,
): boolean {
  if (rule === undefined) {
    return false
  }
  return (
    suppressionWaivesOwnLine(lines[index] ?? '', rule) ||
    (index > 0 && suppressionWaivesNextLine(lines[index - 1] ?? '', rule))
  )
}
