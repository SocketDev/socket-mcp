/*
 * @file The INLINE review-comment law, as code. Sibling to `pr-body-law.mts`,
 *   which governs a PR body, and to `docs/agents.md/fleet/pr-review-comments.md`,
 *   which governs the summary comment's severity folds. Neither covers the
 *   shape this module owns: a comment anchored to specific diff lines, usually
 *   carrying a ```suggestion block.
 *
 *   That shape has its own failure modes, and every clause below is one that
 *   fired during a live two-PR review of a release-asset relay service. The
 *   review posted fifteen inline comments; the corrections that followed are
 *   the law:
 *
 *   - ANCHOR ON A COMPUTED LINE. GitHub anchors a review comment to a
 *     new-file line that must exist in the diff. Estimating it either 422s or,
 *     worse, lands the comment on unrelated code. Parse the hunk headers and
 *     compute the number; never eyeball it from a rendered diff.
 *   - PREFER THE NATIVE SUGGESTION, A GITHUB SPECIAL CASE. Where the fix is a
 *     line-range replacement, ship a ```suggestion block: GitHub renders it as
 *     a committable patch the reviewer applies in one click. This overrides the
 *     fleet's `Suggestion 💡:` label, which exists for surfaces with no
 *     commit-a-patch affordance. Describing in prose a fix the surface could
 *     have applied is strictly worse for the reader.
 *   - A SUGGESTION REPLACES ITS RANGE EXACTLY. The anchored range and the
 *     block's contents are a 1:1 swap. A block that assumes surrounding lines
 *     it did not anchor produces a patch that does not apply.
 *   - ABSORB THE COMMENT ABOVE, DO NOT STACK ON IT. When the anchored code
 *     already carries an explanatory comment, extend the anchor upward and
 *     rewrite it. Three separate suggestions in that review would otherwise
 *     have stacked a second comment on one statement, or left a sentence that
 *     the fix made false ("the only artifact in the deploy" after the fix
 *     covered two).
 *   - MATCH THE FILE'S COMMENT DENSITY, MEASURED. Comment frequency is a
 *     per-file property. In that review the target files ran 18% to 55%
 *     comment lines, so a four-line doc block on one constant was too heavy
 *     where the neighbours carried one-liners, and a zero-comment shell guard
 *     was too light in a file at 28%. Count, then match.
 *   - NAME A CONSTANT, NEVER A BARE LITERAL. A magic number in suggested code
 *     is the same defect in a review as in a commit. Exempt: the constant's own
 *     definition site, and a value whose local convention is already literal
 *     (raw HTTP status codes in a file that writes `res.status(404)`).
 *   - TERSE PROSE, THEN THE SUGGESTION. The block carries the detail; prose
 *     that restates it doubles the reading. The budget is words, not sentences,
 *     because three short sentences read tighter than two long ones: the
 *     reviewed comments landed at 16 to 50 words each, so the cap is 60.
 *   - NAME THE FILE, NOT ITS ROLE. "the runbook" made a reader ask which
 *     document; `docs/installer-hosting.md` did not.
 *   - AN UNANCHORABLE FINDING GOES IN THE REVIEW BODY. A defect in a file the
 *     diff does not touch has no valid line. Put it in the body and say why it
 *     is not inline; never invent a nearby anchor.
 *   - DO NOT CITE A CONVENTION THE TARGET REPO DOES NOT ENFORCE. Fleet doctrine
 *     is not universal. Check for the guard before invoking it, and when it is
 *     absent, mark the note as a preference.
 *
 *   `reviewCommentSmells` is ADVISORY, named so no caller mistakes it for a
 *   gate, matching the precedent `prBodySmells` set. The detectors are
 *   heuristics over comment text: sentence counting cannot see a code span that
 *   contains a period, and the bare-literal scan cannot know a target file's
 *   local conventions. Do not wire this into a blocking check without evidence
 *   from real comments that it does not false-positive.
 */

export type ReviewCommentRuleId =
  | 'absorb-adjacent-comment'
  | 'anchor-is-computed'
  | 'match-comment-density'
  | 'name-the-constant'
  | 'name-the-file'
  | 'no-foreign-convention'
  | 'prefer-native-suggestion'
  | 'suggestion-replaces-range'
  | 'terse-prose'
  | 'unanchorable-goes-in-body'

/**
 * One clause of the law, as data.
 */
export interface ReviewCommentLawEntry {
  id: ReviewCommentRuleId
  rule: string
}

/**
 * One advisory finding against one inline comment.
 */
export interface ReviewCommentSmell {
  /**
   * What to do about it, in one sentence.
   */
  detail: string
  rule: ReviewCommentRuleId
  /**
   * The offending fragment, trimmed to something quotable.
   */
  where: string
}

/**
 * Words of prose an inline comment may carry before its suggestion. This is the
 * primary budget, because it is what "short" actually measures: the calibration
 * set of sixteen operator-approved comments ran 16 to 50 words, so 60 leaves
 * headroom without admitting a paragraph.
 */
export const MAX_INLINE_PROSE_WORDS = 60

/**
 * Sentences of prose before the suggestion. A loose secondary cap, because
 * sentence count is a poor proxy for length: three short sentences read tighter
 * than two long ones, and the calibration set topped out at four. An early
 * draft of this module capped it at two and flagged thirteen of those sixteen.
 */
export const MAX_INLINE_PROSE_SENTENCES = 4

/**
 * How far a suggestion's comment density may sit from its target file's,
 * in percentage points, before it reads as foreign to that file.
 */
export const DENSITY_TOLERANCE_POINTS = 10

/**
 * Digit runs that are never worth naming: an index, a bare pair, a year-like
 * token in a URL. Two digits is where a literal starts carrying meaning.
 */
export const MIN_NAMEABLE_LITERAL_DIGITS = 2

/**
 * The nine clauses, in the order a comment is written (not sorted, the order
 * is the lesson): anchor it, shape the suggestion, then write the prose.
 */
export const REVIEW_COMMENT_LAW: readonly ReviewCommentLawEntry[] =
  Object.freeze([
    Object.freeze({
      id: 'anchor-is-computed' as ReviewCommentRuleId,
      rule: 'Compute the new-file line from the diff hunks. An estimated anchor either fails the API or lands on unrelated code.',
    }),
    Object.freeze({
      id: 'prefer-native-suggestion' as ReviewCommentRuleId,
      rule: 'On GitHub, a fix expressible as a line-range replacement ships as a native ```suggestion block, not as prose. This OVERRIDES the `Suggestion 💡:` label, which is for surfaces that have no commit-a-patch affordance. Reach for the label only when the fix spans files, needs judgement, or the surface cannot render a suggestion.',
    }),
    Object.freeze({
      id: 'suggestion-replaces-range' as ReviewCommentRuleId,
      rule: 'A ```suggestion block is a 1:1 replacement for the exact anchored range. A block that assumes lines it did not anchor produces a patch that will not apply.',
    }),
    Object.freeze({
      id: 'absorb-adjacent-comment' as ReviewCommentRuleId,
      rule: 'When the anchored code sits under an explanatory comment, extend the anchor upward and rewrite that comment. Never stack a second comment on one statement, and never leave a sentence the fix made false.',
    }),
    Object.freeze({
      id: 'match-comment-density' as ReviewCommentRuleId,
      rule: "Measure the target file's comment-line percentage and match it. Comment frequency is a per-file property, so a heavy doc block is wrong in a terse file and a bare guard is wrong in a commented one.",
    }),
    Object.freeze({
      id: 'name-the-constant' as ReviewCommentRuleId,
      rule: "Suggested code names its constants. A bare literal is exempt only at that constant's definition site, or where the file's own convention is already literal.",
    }),
    Object.freeze({
      id: 'terse-prose' as ReviewCommentRuleId,
      rule: 'Keep the prose above the suggestion under 60 words, a few short sentences. The block carries the detail; prose that restates it doubles the reading.',
    }),
    Object.freeze({
      id: 'name-the-file' as ReviewCommentRuleId,
      rule: 'Name the file, not its role. "the runbook" makes a reader ask which document; a path does not.',
    }),
    Object.freeze({
      id: 'unanchorable-goes-in-body' as ReviewCommentRuleId,
      rule: 'A finding in a file the diff does not touch goes in the review body, with one clause saying why it is not inline. Never invent a nearby anchor.',
    }),
    Object.freeze({
      id: 'no-foreign-convention' as ReviewCommentRuleId,
      rule: 'Check that the target repo enforces a convention before citing it. Fleet doctrine does not apply outside the fleet; when no guard exists, mark the note as a preference and say so.',
    }),
  ])

/**
 * The law as a verbatim prompt block, for any agent prompt that may post an
 * inline review comment. Paraphrase is how a rule decays into a suggestion.
 */
export const REVIEW_COMMENT_LAW_PROMPT = [
  'Inline review-comment law (verbatim, non-negotiable):',
  ...REVIEW_COMMENT_LAW.map(entry => `- ${entry.rule}`),
].join('\n')

// A fenced suggestion block, capturing its contents. Tolerates the four-tick
// fence a block containing three-tick code needs.
const SUGGESTION_RE = /^\s{0,3}(`{3,})suggestion\s*$([\s\S]*?)^\s{0,3}\1\s*$/gm
// A role word standing in for a document. Matched with a leading article so
// "the runbook" is a hit and "runbook.md" is not.
const ROLE_WORD_RE =
  /\b(?:that|the|this)\s+(?:runbook|doc|document|spec|guide|playbook|writeup)\b/gi
// The fleet's prose remediation label, with or without its bulb.
const FIX_LABEL_RE = /\bfix\s+idea\b/i
// A digit run that is not part of an identifier, a decimal, a version, or a
// percent. Leading guard rejects a preceding word char, dot, dollar, dash, or
// slash so `MAX_2`, `1.5`, `$1`, `v2`, and `a/2` are all skipped.
const BARE_LITERAL_RE = /(?<![\w.$/-])(\d{2,})(?![\w.%])/g
// A line that DEFINES a constant, which is the one place a literal belongs.
const DEFINITION_RE =
  /^\s*(?:export\s+)?(?:const|final|let|static|var)\b|^\s*[A-Z][A-Z0-9_]*\s*[:=]/
// A comment line in the languages the fleet reviews. Sorted alphanumerically
// per socket/sort-regex-alternations; safe here because no alternative is a
// prefix of another, so first-match order cannot change what this accepts.
const COMMENT_LINE_RE = /^\s*(?:#|--|\*|\/\*|\/\/)/

/**
 * Every ```suggestion block in a comment body, in order.
 */
export function suggestionBlocks(body: string): string[] {
  const blocks: string[] = []
  SUGGESTION_RE.lastIndex = 0
  let match = SUGGESTION_RE.exec(body)
  while (match) {
    blocks.push((match[2] ?? '').replace(/^\n/, '').replace(/\n$/, ''))
    match = SUGGESTION_RE.exec(body)
  }
  return blocks
}

/**
 * The prose above the first suggestion block, which is the part a reader reads
 * before deciding to look at the code.
 */
export function leadProse(body: string): string {
  const at = body.search(/^\s{0,3}`{3,}suggestion\s*$/m)
  return (at === -1 ? body : body.slice(0, at)).trim()
}

/**
 * Sentence count for a prose block, with code spans removed first so a period
 * inside `res.status(404)` does not read as a sentence end.
 */
export function proseSentenceCount(text: string): number {
  const withoutCode = text.replace(/`[^`]*`/g, 'X')
  const sentences = withoutCode
    .split(/[.!?](?:\s|$)/)
    .map(part => part.trim())
    .filter(Boolean)
  return sentences.length
}

/**
 * Percentage of non-blank lines that are comments, which is the number to
 * match against the target file. Returns 0 for an empty block.
 */
export function commentDensity(code: string): number {
  const lines = code.split('\n').filter(line => line.trim())
  if (!lines.length) {
    return 0
  }
  const comments = lines.filter(line => COMMENT_LINE_RE.test(line)).length
  return Math.round((100 * comments) / lines.length)
}

/**
 * Bare numeric literals in suggested code that are worth naming. Skips any
 * line that defines a constant, since that is where the literal belongs, and
 * skips comment lines, where a number is prose.
 */
export function bareLiterals(code: string): string[] {
  const found: string[] = []
  const lines = code.split('\n')
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    if (COMMENT_LINE_RE.test(line) || DEFINITION_RE.test(line)) {
      continue
    }
    BARE_LITERAL_RE.lastIndex = 0
    let match = BARE_LITERAL_RE.exec(line)
    while (match) {
      found.push(match[1]!)
      match = BARE_LITERAL_RE.exec(line)
    }
  }
  return [...new Set(found)]
}

/**
 * Advisory findings against one inline review-comment body. Reports only what
 * is decidable from the comment text alone: the anchor rules and the density
 * rule need the diff and the target file, so they stay author-checked.
 */
export function reviewCommentSmells(body: string): ReviewCommentSmell[] {
  const smells: ReviewCommentSmell[] = []
  const lead = leadProse(body)

  const words = lead.split(/\s+/).filter(Boolean).length
  if (words > MAX_INLINE_PROSE_WORDS) {
    smells.push({
      detail: `Trim to ${MAX_INLINE_PROSE_WORDS} words and let the suggestion carry the rest.`,
      rule: 'terse-prose',
      where: `${words} words of lead prose`,
    })
  }

  const sentences = proseSentenceCount(lead)
  if (sentences > MAX_INLINE_PROSE_SENTENCES) {
    smells.push({
      detail: `Split or cut: ${MAX_INLINE_PROSE_SENTENCES} sentences is the ceiling before a comment reads as a paragraph.`,
      rule: 'terse-prose',
      where: `${sentences} sentences of lead prose`,
    })
  }

  ROLE_WORD_RE.lastIndex = 0
  let roleMatch = ROLE_WORD_RE.exec(lead)
  while (roleMatch) {
    smells.push({
      detail:
        'Name the file instead, so the reader does not have to ask which one.',
      rule: 'name-the-file',
      where: roleMatch[0],
    })
    roleMatch = ROLE_WORD_RE.exec(lead)
  }

  const blocks = suggestionBlocks(body)

  // A prose fix on a surface that can commit a patch. Only fires when no block
  // is present at all: a comment carrying both is describing the residue the
  // suggestion does not cover, which is correct.
  if (!blocks.length && FIX_LABEL_RE.test(body)) {
    smells.push({
      detail:
        'On GitHub, ship the fix as a ```suggestion block instead. Keep the label only if the fix spans files or needs judgement.',
      rule: 'prefer-native-suggestion',
      where: 'Suggestion label with no suggestion block',
    })
  }

  for (let i = 0, { length } = blocks; i < length; i += 1) {
    const literals = bareLiterals(blocks[i]!)
    if (literals.length) {
      smells.push({
        detail: `Name these as constants, or say why the file's convention keeps them literal: ${literals.join(', ')}.`,
        rule: 'name-the-constant',
        where: `suggestion ${i + 1}`,
      })
    }
  }

  return smells
}
