#!/usr/bin/env node
/*
 * @file Code-as-law for John-David's public GitHub PR/issue comments — the
 *   voice rules distilled from the pnpm/rfcs#19 engagement (2026-08-06), so
 *   drafts get linted instead of re-litigated. Pipe a draft through before
 *   posting; exit 1 means fix it first. Each rule encodes the PATTERN behind
 *   a live correction on a posted comment, never the incident's exact words:
 *   gatekeeping the author's scope reads hostile; agreement words after 👍
 *   are redundant; em dashes read as AI tell; spec-speak loses readers;
 *   a question buried mid-paragraph gets skimmed past; a comment with
 *   nothing to apply or answer wastes the author's attention; and a
 *   standalone comment whose status words point outside itself ("still
 *   open") points at nothing. Fenced blocks are exempt from the prose rules because
 *   suggestion-block content becomes the TARGET DOCUMENT's text and must
 *   match its style (the pnpm RFCs use em dashes, for example).
 *   The message-vs-reaction decision tree (print with --rules):
 *
 *   1. Our finding, our ask, or a thread we are in: message.
 *   2. Agreeing with a bot finding on our review: a "👍 - ..." message, because a
 *      bare reaction is not in the message record.
 *   3. Someone else's thread, resolved our way, nothing to add: reaction only.
 *   4. Nothing to add, no position to signal: nothing. Usage: `node
 *      scripts/fleet/comment-voice.mts [--thread] [file]` (reads stdin when
 *      no file is given), or `--rules` to print the decision tree. The
 *      --thread flag permits referents ("still open", "still true") that
 *      only make sense inside a reply thread. Exit codes: 0 = clean (warnings
 *      allowed), 1 = violations.
 *
 *   Slack delivery: owner-voice Slack messages go out as DRAFTS
 *   (slack_send_message_draft), never direct sends - Slack's app byline on a
 *   direct send cannot be suppressed, while a draft posts as purely the
 *   owner. A CLEAN draft prints a copy affordance built on the x-socketsecurity--fleet
 *   fill handler (docs/agents.md/fleet/human-gates.md): where the terminal
 *   renders OSC 8, a click hands the draft to the handler, which puts it on
 *   the CLIPBOARD and stops; everywhere else (including agent-run pipes) a
 *   verbatim `pbcopy < <tempfile>` line does the same one paste later.
 *   Nothing touches the clipboard without the operator's click or command.
 */

const RULES = `
Message rules (enforced):
  - 3 sentences max (WARN - clarity beats compression when they conflict)
  - questions lead; blank line; then context
  - every message is actionable: a suggestion block, a question, or a 👍 log
  - agreement format is "👍 - ..." (hyphen; the 👍 already means agreed)
  - regular hyphens only in prose; em dashes allowed inside fenced blocks
    (suggestion text mirrors the target document's style)
  - plain words; excitement not judgment; never gatekeep the author's scope
  - standalone comments are self-contained (no "still open" without a thread)

Reaction rule:
  - someone else's thread + resolution already matches our position + nothing
    to add = react (👍) on their resolving comment, do not post. A reaction
    signals "read and agreed" without inserting ourselves into their exchange.

Slack rule:
  - owner-voice Slack messages go out as DRAFTS (slack_send_message_draft),
    never direct sends - the app byline on a direct send cannot be
    suppressed; a draft posts as purely the owner. A clean draft prints a
    copy link (click puts it on the clipboard via the x-socketsecurity--fleet handler) or
    a verbatim pbcopy command where links do not render.
`

type Finding = { level: 'ERROR' | 'WARN'; rule: string; detail: string }

function stripFences(body: string): { prose: string; hasSuggestion: boolean } {
  const lines = body.split('\n')
  const prose: string[] = []
  let inFence = false
  let hasSuggestion = false
  for (let i = 0, { length } = lines; i < length; i += 1) {
    const line = lines[i]!
    const t = line.trim()
    if (t.startsWith('```')) {
      if (!inFence && t === '```suggestion') {
        hasSuggestion = true
      }
      inFence = t !== '```'
      continue
    }
    if (!inFence && !t.startsWith('>')) {
      prose.push(line)
    }
  }
  return { prose: prose.join('\n'), hasSuggestion }
}

export function lint(body: string, config: { thread: boolean }): Finding[] {
  const cfg = { __proto__: null, ...config }
  const { thread } = cfg
  const findings: Finding[] = []
  const { prose, hasSuggestion } = stripFences(body)
  const noCode = prose.replace(/`[^`]*`/g, '')

  if (prose.includes('—')) {
    findings.push({
      level: 'ERROR',
      rule: 'hyphens-only',
      detail: 'em dash in prose; use "-" (fenced blocks are exempt)',
    })
  }
  if (/👍\s*—/.test(prose)) {
    findings.push({
      level: 'ERROR',
      rule: 'thumbs-format',
      detail: 'use "👍 - ...", not an em dash',
    })
  }
  // Any agreement word right after the 👍 prefix: "agreed", "agree",
  // "correct", "exactly", "right", "yes" - the emoji already says it.
  if (/👍\s*-\s*(?:agreed?|correct|exactly|right|yes)\b/i.test(prose)) {
    findings.push({
      level: 'ERROR',
      rule: 'redundant-agreed',
      detail: 'the 👍 already signals agreement - drop the agreement word',
    })
  }

  // Pattern families, not incident words: each entry names the failure
  // mode; extend the alternation when a new instance of the family shows up.
  const banned: Array<[RegExp, string]> = [
    // Commanding the author's scope: "keep it/that/this out (of ...)".
    [
      /\bkeep (?:it|that|this) out\b/i,
      'gatekeeping - affirm their framing ("this can come later")',
    ],
    // Grading the author's work: "done/got it correctly/properly/right".
    [
      /\b(?:done|got (?:it|this)) (?:correctly|properly|right)\b/i,
      'judgy - frame as excitement instead',
    ],
    // First-person negativity about our own tooling, in one sentence:
    // our/us/we ... then a negative descriptor before the sentence ends.
    [
      /\b(?:our|us|we)\b[^.!?]*\b(?:a mess|awful|hacky|miserable|painful|terrible)\b/i,
      'self-deprecation of our own product',
    ],
    // Spec-speak a plain word replaces: ordinal(s) -> "revision number",
    // equivocate/-ing/-ion -> "same sequence, different contents",
    // supersede(s/d/ing) -> "replaces". Backticked field names are exempt
    // because inline code is stripped before this check.
    [
      /\b(?:equivocat\w*|ordinals?|supersed(?:ed|es?|ing))\b/i,
      'spec-speak - use plain words',
    ],
    // Hedge/honesty framing: candidly, frankly, honest/honesty/honestly.
    [/\b(?:candidly|frankly|honest(?:ly|y)?)\b/i, 'hedge framing - banned'],
  ]
  for (const [re, why] of banned) {
    if (re.test(noCode)) {
      findings.push({
        level: 'ERROR',
        rule: 'banned-phrase',
        detail: `${re.source}: ${why}`,
      })
    }
  }

  const paragraphs = prose
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
  const hasQuestion = /\?/.test(noCode)
  if (hasQuestion && paragraphs.length > 0 && !paragraphs[0]!.includes('?')) {
    findings.push({
      level: 'ERROR',
      rule: 'question-leads',
      detail:
        'a question exists but does not lead; put it first, then a blank line, then context',
    })
  }

  const firstLine =
    body.split('\n').find(l => l.trim() && !l.trim().startsWith('>')) ?? ''
  const startsThumb = firstLine.trimStart().startsWith('👍')
  if (!hasQuestion && !hasSuggestion && !startsThumb) {
    findings.push({
      level: 'ERROR',
      rule: 'actionable',
      detail:
        'no question, no suggestion block, not a 👍 log - give them something to act on',
    })
  }

  const sentences = noCode
    .replace(/\n/g, ' ')
    .split(/[.!?]+\s/)
    .map(s => s.trim())
    .filter(s => s.length > 2)
  if (sentences.length > 3) {
    findings.push({
      level: 'WARN',
      rule: 'three-sentences',
      detail: `${sentences.length} sentences; 3 is the target - keep it only if clarity demands`,
    })
  }

  // Status referents that point outside the comment: remain(s)/still +
  // a discussion-state word, any case, any whitespace between the words
  // (drafts hard-wrap). These only resolve inside a reply thread; a
  // 👍-opening reply is by definition a thread reply and is linted with
  // --thread, so no emoji-shaped branch is needed here.
  if (
    !thread &&
    /\b(?:remains?|still)\s+(?:open|the case|true|unaddressed|unfixed|unresolved)\b/i.test(
      noCode,
    )
  ) {
    findings.push({
      level: 'WARN',
      rule: 'self-contained',
      detail:
        'a status referent ("still open") points outside this comment; pass --thread if this is a reply',
    })
  }

  return findings
}

type CliIo = {
  log: (line: string) => void
  readStdin: () => Promise<string>
}

// A clean draft's copy affordance, built on the x-socketsecurity--fleet fill handler
// (docs/agents.md/fleet/human-gates.md). Clicking the OSC 8 link hands the
// draft to the handler, which puts it on the CLIPBOARD and stops - fill
// never submits, and nothing here writes the clipboard on its own. Where
// the terminal does not render hyperlinks (agent-run pipes included), the
// draft goes to a temp file and the line carries a verbatim pbcopy command
// instead - same draft, one paste away.
async function copyLine(body: string): Promise<string> {
  const { copyUrl, osc8Link, supportsHyperlinks } =
    await import('./_shared/terminal-link.mts')
  if (supportsHyperlinks()) {
    return `copy: ${osc8Link('click to copy the draft', copyUrl(body))}`
  }
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), 'comment-voice-')),
    'draft.md',
  )
  writeFileSync(file, body)
  return `copy: pbcopy < ${file}`
}

export async function runCli(
  args: string[],
  io?: Partial<CliIo> | undefined,
): Promise<number> {
  const log = io?.log ?? console.log
  if (args.includes('--rules')) {
    log(RULES)
    return 0
  }
  const thread = args.includes('--thread')
  const file = args.find(a => !a.startsWith('--'))
  const readStdin =
    io?.readStdin ??
    (() =>
      new Promise<string>(resolve => {
        let d = ''
        process.stdin.on('data', c => (d += c))
        process.stdin.on('end', () => resolve(d))
      }))
  const body = file
    ? (await import('node:fs')).readFileSync(file, 'utf8')
    : await readStdin()

  const findings = lint(body, { thread })
  for (const f of findings) {
    log(`${f.level}  ${f.rule}: ${f.detail}`)
  }
  const errors = findings.filter(f => f.level === 'ERROR').length

  // A clean draft earns its copy affordance ahead of the verdict line, so
  // the verdict stays the last word on stdout.
  if (!errors) {
    log(await copyLine(body))
  }
  log(
    errors
      ? `\n${errors} violation(s)`
      : findings.length
        ? '\nclean (warnings only)'
        : 'clean',
  )
  return errors ? 1 : 0
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  // process.exitCode, never process.exit(): a pipe write is ASYNC on Windows,
  // so exiting outright drops whatever stdout has not flushed. --rules prints
  // the largest payload here and lost all of it, surfacing as an exit-0 run
  // with empty stdout. Setting the code lets node drain and exit on its own,
  // and matches the fleet's own run-main convention.
  void runCli(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
