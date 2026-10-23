export interface NativeArtifactFilePlan {
  source: string
  destination: string
  platformId: string
}

const DEFAULT_ARTIFACT_FILES = {
  'opentui.node': 'npm/{platformId}/opentui.node',
  'stuie.node': 'npm/{platformId}/stuie.node',
}

export function planNativeArtifactFiles(
  artifactFiles: Readonly<Record<string, string>> | undefined,
  targets: ReadonlyArray<{ target: string; platformId: string }>,
): NativeArtifactFilePlan[] {
  const files = artifactFiles ?? DEFAULT_ARTIFACT_FILES
  const entries = Object.entries(files)
  if (
    entries.length === 0 ||
    entries.some(
      ([filename, destination]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.node$/u.test(filename) ||
        typeof destination !== 'string' ||
        destination.length === 0,
    )
  ) {
    throw new Error(
      'Native artifact file config is invalid. Where: napi.artifactFiles. Saw an empty or unsafe filename; wanted safe .node basenames and relative destinations. Fix: correct the source-to-destination map.',
    )
  }
  const outputs = new Set<string>()
  const plan: NativeArtifactFilePlan[] = []
  for (let index = 0, { length } = targets; index < length; index += 1) {
    const target = targets[index]!
    for (const [filename, template] of entries) {
      const destination = template
        .replaceAll('{target}', () => target.target)
        .replaceAll('{platformId}', () => target.platformId)
      const segments = destination.split('/')
      if (
        destination.startsWith('/') ||
        destination.includes('\\') ||
        !destination.endsWith('.node') ||
        /[{}]/u.test(destination) ||
        segments.some(
          segment =>
            segment.length === 0 ||
            segment === '.' ||
            segment === '..' ||
            !/^[A-Za-z0-9._+-]+$/u.test(segment),
        )
      ) {
        throw new Error(
          'Native artifact destination is unsafe. Where: napi.artifactFiles. Saw an absolute, traversal, or unknown-token path; wanted a safe relative .node path. Fix: use relative filename segments and supported tokens.',
        )
      }
      if (outputs.has(destination)) {
        throw new Error(
          'Native artifact destinations collide. Where: napi.artifactFiles. Saw duplicate output names; wanted one destination per artifact file. Fix: include {target} or {platformId} where needed.',
        )
      }
      outputs.add(destination)
      plan.push({
        source: filename,
        destination,
        platformId: target.platformId,
      })
    }
  }
  return plan
}
