/*
 * @file The outbound-surface registry: what each place we post to actually
 *   RENDERS, how a fix is offered there, and how long a message may run. Third
 *   layer of a trio that deliberately does not overlap:
 *
 *     `.claude/hooks/fleet/_shared/outbound-bodies.mts`  WHERE the text is
 *     `.claude/hooks/fleet/_shared/outbound-voice.mts`   WHICH WORDS are off-voice
 *     this module                                        WHAT SHAPE the surface takes
 *
 *   The gap it closes: voice rules are surface-independent (a banned word is
 *   banned everywhere), but SHAPE is not. A `<details>` fold is the right
 *   affordance on GitHub and dead markup in a Linear comment. `**bold**` is
 *   bold on GitHub and literal asterisks in Slack, which wants `*bold*`. A
 *   ```suggestion block is a committable patch on a GitHub pull request and
 *   plain grey code everywhere else. Posting one surface's shape to another is
 *   how a careful message arrives looking broken.
 *
 *   THE FIX AFFORDANCE IS THE POINT. Where a surface can apply a patch, offer
 *   the patch; the fleet's `Suggestion 💡:` label exists for surfaces that
 *   cannot. Describing in prose a change the reader could have committed in one
 *   click is strictly worse for them. `review-comment-law.mts` states the same
 *   rule from the review side.
 *
 *   VERIFICATION STATUS, stated plainly because it bounds how much to trust a
 *   row. The GitHub rows are verified: the fleet posts there constantly and
 *   `pr-body-law.mts`, `pr-review-comments.md`, and this session's own review
 *   exercised every affordance listed. The Slack, Linear, and Notion rows
 *   encode documented product behavior that CANNOT be verified from this
 *   repository, so they are the operating assumption rather than a receipt.
 *   Correct a row on first contact with the live surface rather than working
 *   around it, and move it to verified when you do.
 */

/**
 * How a reader can act on a proposed change, which decides whether a fix is
 * shipped as a patch or described.
 *
 * - `native-suggestion`: the surface renders a committable patch block.
 * - `prose-suggestion`: no patch affordance; use the fleet's `Suggestion 💡:`
 *   label.
 * - `prose-only`: not even a code fence renders well; describe in a sentence.
 */
export type FixAffordance =
  | 'prose-suggestion'
  | 'native-suggestion'
  | 'prose-only'

/**
 * Whether a row is backed by a receipt or is documented product behavior this
 * repository cannot check.
 */
export type SurfaceConfidence = 'assumed' | 'verified'

export type OutboundSurfaceId =
  | 'commit-body'
  | 'github-issue'
  | 'github-pr-body'
  | 'github-pr-inline'
  | 'github-pr-summary'
  | 'linear'
  | 'notion-comment'
  | 'slack'

/**
 * One outbound surface, as data.
 */
export interface OutboundSurface {
  /**
   * Shapes that break or read wrong here.
   */
  avoid: readonly string[]
  confidence: SurfaceConfidence
  fixAffordance: FixAffordance
  id: OutboundSurfaceId
  label: string
  /**
   * Soft word budget for one message. Exceeding it is a signal to split or
   * fold, not an error.
   */
  maxWords: number
  /**
   * The one thing to remember about writing here.
   */
  note: string
  /**
   * Formatting that actually renders.
   */
  renders: readonly string[]
}

/**
 * Word budget for a surface with no documented ceiling. Long enough for a real
 * explanation, short enough that a wall of text trips it.
 */
export const DEFAULT_SURFACE_MAX_WORDS = 400

export const OUTBOUND_SURFACES: readonly OutboundSurface[] = Object.freeze([
  Object.freeze({
    avoid: ['severity folds, which are overkill for one anchored line'],
    confidence: 'verified' as SurfaceConfidence,
    fixAffordance: 'native-suggestion' as FixAffordance,
    id: 'github-pr-inline' as OutboundSurfaceId,
    label: 'GitHub pull request, inline review comment',
    maxWords: 60,
    note: 'Anchored to diff lines. Ship the fix as a suggestion block and keep the prose under it. Full law in review-comment-law.mts.',
    renders: ['GFM', 'suggestion blocks', 'details folds', 'permalinks'],
  }),
  Object.freeze({
    avoid: ['intra-comment anchors, which cannot open inside a collapsed fold'],
    confidence: 'verified' as SurfaceConfidence,
    fixAffordance: 'prose-suggestion' as FixAffordance,
    id: 'github-pr-summary' as OutboundSurfaceId,
    label: 'GitHub pull request, summary review comment',
    maxWords: DEFAULT_SURFACE_MAX_WORDS,
    note: 'Severity-sorted folds with abbr circles. Not anchored, so no suggestion affordance: this is where the Suggestion label belongs. Full law in pr-review-comments.md.',
    renders: ['GFM', 'details folds', 'abbr hover text', 'tables', 'alerts'],
  }),
  Object.freeze({
    avoid: ['diff narration', 'more than one alert block'],
    confidence: 'verified' as SurfaceConfidence,
    fixAffordance: 'prose-suggestion' as FixAffordance,
    id: 'github-pr-body' as OutboundSurfaceId,
    label: 'GitHub pull request body',
    maxWords: DEFAULT_SURFACE_MAX_WORDS,
    note: 'Lead with the outcome, fold the supporting detail. Full law in pr-body-law.mts.',
    renders: [
      'GFM',
      'details folds',
      'tables',
      'alerts',
      'task lists',
      'footnotes',
    ],
  }),
  Object.freeze({
    avoid: [
      'suggestion blocks, which render as plain code with nothing to apply',
    ],
    confidence: 'verified' as SurfaceConfidence,
    fixAffordance: 'prose-suggestion' as FixAffordance,
    id: 'github-issue' as OutboundSurfaceId,
    label: 'GitHub issue body or comment',
    maxWords: DEFAULT_SURFACE_MAX_WORDS,
    note: 'Same markdown as a PR body, but no diff to anchor to, so every fix is described rather than offered.',
    renders: ['GFM', 'details folds', 'tables', 'alerts', 'task lists'],
  }),
  Object.freeze({
    avoid: ['raw HTML, including details folds and abbr', 'suggestion blocks'],
    confidence: 'assumed' as SurfaceConfidence,
    fixAffordance: 'prose-suggestion' as FixAffordance,
    id: 'linear' as OutboundSurfaceId,
    label: 'Linear issue or comment',
    maxWords: 250,
    note: 'Markdown subset, no raw HTML: a details fold posts as visible tags. Structure with headings and lists instead, and let the issue body hold what a fold would have hidden.',
    renders: ['headings', 'lists', 'code fences', 'tables', 'links'],
  }),
  Object.freeze({
    avoid: [
      'GFM bold (`**x**`), which posts as literal asterisks',
      'tables',
      'details folds',
    ],
    confidence: 'assumed' as SurfaceConfidence,
    fixAffordance: 'prose-only' as FixAffordance,
    id: 'slack' as OutboundSurfaceId,
    label: 'Slack message',
    maxWords: 120,
    note: 'mrkdwn, not markdown: single asterisks for bold, `<url|text>` links. Put depth in a thread reply rather than a longer message.',
    renders: [
      'mrkdwn bold/italic/strike',
      'code fences',
      'block quotes',
      'lists',
    ],
  }),
  Object.freeze({
    avoid: ['raw HTML', 'tables', 'anything relying on a fold'],
    confidence: 'assumed' as SurfaceConfidence,
    fixAffordance: 'prose-only' as FixAffordance,
    id: 'notion-comment' as OutboundSurfaceId,
    label: 'Notion comment',
    maxWords: 150,
    note: 'Closer to plain text than markdown. Keep it to sentences and short lists; put anything structured on the page itself, not in the comment.',
    renders: ['plain text', 'inline code', 'links', 'mentions'],
  }),
  Object.freeze({
    avoid: [
      'markdown of any kind, which renders nowhere',
      'lines over 72 columns',
    ],
    confidence: 'verified' as SurfaceConfidence,
    fixAffordance: 'prose-only' as FixAffordance,
    id: 'commit-body' as OutboundSurfaceId,
    label: 'Git commit body',
    maxWords: 200,
    note: 'Hard-wrapped plain text under a Conventional Commits subject. Explain why, not what the diff already shows.',
    renders: ['plain text'],
  }),
])

/**
 * Tool invocations that publish to each surface, keyed the same way
 * `outbound-bodies.mts` recognizes them, so the two layers agree on identity.
 */
const SURFACE_BY_TOOL: ReadonlyMap<string, OutboundSurfaceId> = new Map([
  ['mcp__claude_ai_Linear__save_comment', 'linear' as OutboundSurfaceId],
  ['mcp__claude_ai_Linear__save_diff_comment', 'linear' as OutboundSurfaceId],
  ['mcp__claude_ai_Linear__save_issue', 'linear' as OutboundSurfaceId],
  [
    'mcp__claude_ai_Notion__notion-create-comment',
    'notion-comment' as OutboundSurfaceId,
  ],
  ['mcp__linear__save_comment', 'linear' as OutboundSurfaceId],
  ['mcp__linear__save_diff_comment', 'linear' as OutboundSurfaceId],
  ['mcp__notion__notion-create-comment', 'notion-comment' as OutboundSurfaceId],
])

/**
 * The surface a tool invocation publishes to, or undefined when the tool does
 * not publish. Slack is matched by shape rather than an exact name because the
 * server prefix varies per workspace, matching how `outbound-bodies.mts`
 * recognizes it.
 */
export function surfaceForTool(
  toolName: string,
): OutboundSurfaceId | undefined {
  const direct = SURFACE_BY_TOOL.get(toolName)
  if (direct) {
    return direct
  }
  const lower = toolName.toLowerCase()
  if (lower.includes('slack') && lower.includes('send_message')) {
    return 'slack'
  }
  return undefined
}

/**
 * One surface by id.
 */
export function surfaceById(
  id: OutboundSurfaceId,
): OutboundSurface | undefined {
  return OUTBOUND_SURFACES.find(surface => surface.id === id)
}

/**
 * The registry as a verbatim prompt block, for any agent prompt that may post
 * outbound text. Rendered as one line per surface so a prompt stays scannable.
 */
export const OUTBOUND_SURFACE_PROMPT = [
  'Outbound-surface shapes (verbatim, non-negotiable):',
  ...OUTBOUND_SURFACES.map(
    surface =>
      `- ${surface.label}: fix as ${surface.fixAffordance}, under ~${surface.maxWords} words. Renders ${surface.renders.join(', ')}. Avoid ${surface.avoid.join('; ')}.`,
  ),
].join('\n')
