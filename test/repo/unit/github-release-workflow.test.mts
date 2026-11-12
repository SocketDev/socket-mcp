import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync('.github/workflows/release-github.yml', 'utf8')
const step = workflow
  .split('      - name: Create or finish GitHub release\n')[1]!
  .split('        run: |\n')[1]!
  .replace(/^          /gmu, '')

// Run the workflow's actual shell with fake GitHub commands; no release is sent.
describe.skipIf(process.platform === 'win32')(
  'GitHub release finalization',
  () => {
    it.each([
      ['new draft', false, '0.4.0'],
      ['existing draft', true, '0.4.0'],
      ['prerelease draft', true, '0.5.0-rc.0'],
    ] as const)(
      'publishes a %s by its database ID',
      (_name, exists, version) => {
        const directory = mkdtempSync(path.join(tmpdir(), 'github-release-'))
        try {
          if (exists) writeFileSync(path.join(directory, 'release-exists'), '')
          const stub = `
gh() {
  echo "$*" >> calls.txt
  case "$1 $2" in
    'release view')
      test -f release-exists || return 1
      if [ "$#" -gt 3 ]; then
        test "$4 $5 $6 $7" = "--json databaseId --jq .databaseId" || return 1
        echo 12345
      fi
      ;;
    'release create')
      test ! -f release-exists || return 1
      touch release-exists
      echo 'https://example.invalid/releases/untagged-draft'
      ;;
    'api repos/example/repo/releases/12345') ;;
    *) echo 'Not Found (HTTP 404)' >&2; return 1 ;;
  esac
}
git() {
  printf '## [%s] - 2026-11-12\\n\\n- A release fix\\n' "$VERSION"
}
`
          execFileSync('bash', ['-c', `${stub}\n${step}`], {
            cwd: directory,
            env: {
              ...process.env,
              TAG: `v${version}`,
              VERSION: version,
              GITHUB_REPOSITORY: 'example/repo',
            },
          })
          const calls = readFileSync(path.join(directory, 'calls.txt'), 'utf8')
          expect(calls).toContain(
            `api repos/example/repo/releases/12345 -X PATCH -F draft=false -F prerelease=${version.includes('-')}`,
          )
          expect(calls.includes('release create')).toBe(!exists)
          if (!exists)
            expect(
              readFileSync(path.join(directory, 'release-notes.md'), 'utf8'),
            ).toContain('- A release fix')
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      },
    )
  },
)
