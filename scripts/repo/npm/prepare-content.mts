export type ReleaseCommit = { sha: string; subject: string }

export function stableVersions(versions: Record<string, unknown>): string[] {
  return Object.keys(versions).filter(version =>
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version),
  )
}

export function compareVersions(a: string, b: string): number {
  const aa = a.split('.').map(Number),
    bb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!
  return 0
}

export function chooseReleaseVersion(
  published: string[],
  commits: ReleaseCommit[],
  reserved: string[],
  hint?: string,
  floor?: string,
): string {
  const highest = [
    published.toSorted(compareVersions).at(-1) ?? '0.0.0',
    floor ?? '0.0.0',
  ]
    .toSorted(compareVersions)
    .at(-1)!
  const meaningful = commits.filter(
    commit =>
      !/^chore\(release\): prepare v\d+\.\d+\.\d+/u.test(commit.subject),
  )
  let candidate: string
  if (hint && /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(hint))
    candidate = hint.replace(/^v/u, '').replace(/-[\w.-]+$/u, '')
  else {
    const [major = 0, minor = 0, patch = 0] = highest.split('.').map(Number)
    const patchOnly =
      meaningful.length > 0 &&
      meaningful.every(commit => /^fix(?:\([^)]*\))?:/u.test(commit.subject))
    candidate = patchOnly
      ? `${major}.${minor}.${patch + 1}`
      : `${major}.${minor + 1}.0`
  }
  if (compareVersions(candidate, highest) <= 0)
    throw new Error(
      `Release version ${candidate} does not exceed the highest published version ${highest}.`,
    )
  const occupied = new Set([...published, ...reserved])
  while (occupied.has(candidate)) {
    const [major = 0, minor = 0, patch = 0] = candidate.split('.').map(Number)
    candidate = `${major}.${minor}.${patch + 1}`
  }
  return candidate
}

export function changelogSection(
  version: string,
  commits: ReleaseCommit[],
  date = new Date().toISOString().slice(0, 10),
): string {
  const rows = commits.filter(
    c => !/^chore\(release\): prepare v\d+\.\d+\.\d+/u.test(c.subject),
  )
  const bullets = rows.length
    ? rows.map(c => `- ${c.subject} (${c.sha.slice(0, 7)})`).join('\n')
    : '- Release preparation.'
  return `## [${version}](https://github.com/SocketDev/socket-mcp/releases/tag/v${version}) - ${date}\n\n${bullets}\n\n`
}

export function insertChangelogSection(
  changelog: string,
  section: string,
): string {
  const first = /^## /mu.exec(changelog)?.index
  return first === undefined
    ? `${changelog.trimEnd()}\n\n${section}`
    : `${changelog.slice(0, first)}${section}${changelog.slice(first)}`
}

export function changelogIntroduction(changelog: string): string {
  const first = /^## /mu.exec(changelog)?.index
  return first === undefined ? changelog : changelog.slice(0, first)
}

export function pinReadmeAssets(readme: string, version: string): string {
  return readme.replace(
    /https:\/\/raw\.githubusercontent\.com\/SocketDev\/socket-mcp\/(?:HEAD|main|v[^/]+)\/assets\//gu,
    `https://raw.githubusercontent.com/SocketDev/socket-mcp/v${version}/assets/`,
  )
}
