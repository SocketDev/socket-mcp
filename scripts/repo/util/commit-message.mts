export const COMMIT_TYPES: readonly string[] = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
]

const HEADER_RE = /^([a-z]+)(?:\([^)]+\))?!?: \S.*$/
const AUTO_SUBJECT_RE = /^(?:(?:amend|fixup|squash)! |Merge\b|Revert\b)/
const AI_ATTRIBUTION_RE =
  /^(?:co-authored-by:.*\b(?:claude|anthropic|copilot|cursor|codex|openai|gemini)\b|.*generated with \[?claude)/im

const SCISSORS_RE = /^# -{24} >8 -{24}$/m

export function stripCommitScissors(message: string): string {
  const match = SCISSORS_RE.exec(message)
  return match ? message.slice(0, match.index) : message
}

export function validateCommitMessage(message: string): string | undefined {
  const body = stripCommitScissors(message)
    .split(/\r?\n/)
    .filter(line => !line.startsWith('#'))
    .join('\n')
    .trim()
  const subject = body.split('\n', 1)[0] ?? ''
  if (!subject) {
    return 'The commit message is empty.'
  }
  if (!AUTO_SUBJECT_RE.test(subject)) {
    const match = HEADER_RE.exec(subject)
    if (!match || !COMMIT_TYPES.includes(match[1]!)) {
      return `The subject "${subject}" is not a Conventional Commit. Wanted <type>(<scope>): <description>, with type one of: ${COMMIT_TYPES.join(', ')}.`
    }
  }
  if (AI_ATTRIBUTION_RE.test(body)) {
    return 'The commit message carries an AI attribution line. Remove it.'
  }
  return undefined
}
