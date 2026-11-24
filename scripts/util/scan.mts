import { readFileSync } from 'node:fs'

export interface ScanHit {
  readonly file: string
  readonly line: number
  readonly rule: string
}

interface ScanRule {
  readonly name: string
  readonly pattern: RegExp
  readonly allow?: ((line: string) => boolean) | undefined
}

const PRIVATE_REPO_NAME = ['socket', 'wheelhouse'].join('-')

const SCAN_RULES: readonly ScanRule[] = [
  {
    name: 'socket-api-key',
    pattern: /sktsec_[a-zA-Z0-9_-]{20,}/,
    allow: line =>
      line.includes('sktsec_t_--') || line.includes('socket-test-fake-token'),
  },
  { name: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'github-token',
    pattern: /\b(?:gh[oprsu]_[A-Za-z0-9._]{36,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  {
    name: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    name: 'personal-path',
    pattern:
      /(?:\/Users\/[^/\s<$]+\/|\/home\/[^/\s<$]+\/|C:\\Users\\[^\\<]+\\)/,
    allow: line =>
      /\/Users\/runner\/|\/home\/(?:circleci|runner|ubuntu|vscode|vsts)\//.test(
        line,
      ),
  },
  {
    name: 'private-repo-name',
    pattern: new RegExp(PRIVATE_REPO_NAME, 'i'),
  },
]

const SKIPPED_FILE_RE =
  /(?:^|\/)(?:pnpm-lock\.yaml|[^/]+\.(?:png|jpg|jpeg|gif|ico|svg|woff2?|ttf|zip|gz|tgz|mcpb))$/

export function scanText(file: string, text: string): ScanHit[] {
  const hits: ScanHit[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0, { length } = lines; index < length; index += 1) {
    const line = lines[index]!
    for (const rule of SCAN_RULES) {
      if (rule.pattern.test(line) && !rule.allow?.(line)) {
        hits.push({ file, line: index + 1, rule: rule.name })
      }
    }
  }
  return hits
}

export type ReadText = (file: string) => string | undefined

export function readWorkingTreeFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw e
  }
}

export function scanFiles(
  files: readonly string[],
  read: ReadText = readWorkingTreeFile,
): ScanHit[] {
  const hits: ScanHit[] = []
  for (const file of files) {
    if (SKIPPED_FILE_RE.test(file)) {
      continue
    }
    const text = read(file)
    if (text === undefined || text.includes('\0')) {
      continue
    }
    hits.push(...scanText(file, text))
  }
  return hits
}

export function formatScanHits(hits: readonly ScanHit[]): string {
  return hits.map(hit => `  ${hit.file}:${hit.line} ${hit.rule}`).join('\n')
}
