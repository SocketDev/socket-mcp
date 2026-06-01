export interface ArtifactData {
  type?: string | undefined
  namespace?: string | undefined
  name?: string | undefined
  version?: string | undefined
  release?: string | undefined
  score?: Record<string, unknown> | undefined
  _type?: string | undefined
  [key: string]: unknown
}

type PlatformPattern = RegExp

const PLATFORM_PATTERNS: Record<string, PlatformPattern[]> = {
  'darwin-arm64': [/macosx.*arm64/i],
  'darwin-x64': [/macosx.*x86_64/i],
  'linux-arm64': [/(linux|manylinux).*(aarch64|arm64)/i],
  'linux-x64': [/(linux|manylinux).*x86_64/i],
  'win32-ia32': [/win.*win32/i],
  'win32-x64': [/win.*(amd64|x86_64)/i],
}

export function artifactGroupKey(artifact: ArtifactData): string {
  const ns = artifact.namespace || ''
  return `${artifact.type || ''}/${ns}/${artifact.name || ''}@${artifact.version || ''}`
}

/**
 * Deduplicate artifacts that share the same (type, namespace, name, version)
 * identity. When multiple artifacts exist for the same package (e.g. PyPI
 * wheels for different platforms), one representative is selected using a
 * priority: platform-matching artifact (if hint provided) > source
 * distribution.
 *
 * > Universal wheel > first artifact.
 */
export function deduplicateArtifacts(
  artifacts: ArtifactData[],
  platform?: string,
): ArtifactData[] {
  const groups = new Map<string, ArtifactData[]>()

  for (let i = 0, { length } = artifacts; i < length; i += 1) {
    const artifact = artifacts[i]!
    const key = artifactGroupKey(artifact)
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
    }
    group.push(artifact)
  }

  const results: ArtifactData[] = []
  // oxlint-disable-next-line socket/prefer-cached-for-loop -- Map.values() iterator, not a bare identifier
  for (const group of groups.values()) {
    results.push(selectBestArtifact(group, platform))
  }

  return results
}

export function isSourceDist(release: string): boolean {
  return /\.(tar\.bz2|tar\.gz|zip)$/i.test(release) || /sdist/i.test(release)
}

export function isUniversalWheel(release: string): boolean {
  return (
    /[-_]none[-_]any\.whl$/i.test(release) ||
    /py3[-_]none[-_]any/i.test(release)
  )
}

export function matchesPlatform(release: string, platform: string): boolean {
  const patterns = PLATFORM_PATTERNS[platform]
  if (patterns) {
    return patterns.some(p => p.test(release))
  }
  return release.toLowerCase().includes(platform.toLowerCase())
}

export function selectBestArtifact(
  artifacts: ArtifactData[],
  platform?: string,
): ArtifactData {
  if (artifacts.length === 1) {
    return artifacts[0]!
  }

  if (platform) {
    const match = artifacts.find(
      a => a.release && matchesPlatform(a.release, platform),
    )
    if (match) {
      return match
    }
  }

  const sdist = artifacts.find(a => a.release && isSourceDist(a.release))
  if (sdist) {
    return sdist
  }

  const universal = artifacts.find(
    a => a.release && isUniversalWheel(a.release),
  )
  if (universal) {
    return universal
  }

  return artifacts[0]!
}
