import { PackageURL } from '@socketregistry/packageurl-js'

/**
 * Build a PURL using packageurl-js for correct encoding across all ecosystems.
 * Handles namespace/name splitting per ecosystem (e.g. npm scoped @scope/name,
 * maven groupId:artifactId, openvsx publisher/extension).
 *
 * The friendly ecosystem name `openvsx` is rewritten to PURL type `vscode` with
 * an auto-added `repository_url=https://open-vsx.org` qualifier, matching the
 * canonical Socket form (e.g.
 * `pkg:vscode/meta/pyrefly@1.0.0?repository_url=...`).
 */
export function buildPurl(
  ecosystem: string,
  depname: string,
  version: string,
  qualifiers?: Record<string, string> | undefined,
): string {
  // `packagist` is the registry name people reach for; the canonical PURL type
  // is `composer`. Alias it so the composer namespace split + lookup apply.
  const rawEcoLower = ecosystem.toLowerCase()
  const ecoLower = rawEcoLower === 'packagist' ? 'composer' : rawEcoLower
  const type = ecoLower === 'openvsx' ? 'vscode' : ecoLower
  const separator = purlNamespaceSeparator(ecoLower, depname)
  const namespace = separator < 0 ? undefined : depname.slice(0, separator)
  const name = separator < 0 ? depname : depname.slice(separator + 1)

  const merged: Record<string, string> = { ...qualifiers }
  if (ecoLower === 'openvsx' && !merged['repository_url']) {
    merged['repository_url'] = 'https://open-vsx.org'
  }

  // `1.0.0` is a stale model-default for ecosystems where the model didn't
  // know the version (npm/pypi historically). For ecosystems whose
  // extensions/packages genuinely publish 1.0.0 (e.g. openvsx, chrome), treat
  // it as a real version.
  const placeholderEcosystems = new Set(['npm', 'pypi'])
  const isPlaceholderVersion =
    version === 'unknown' ||
    !version ||
    (version === '1.0.0' && placeholderEcosystems.has(ecoLower))
  const purlVersion = isPlaceholderVersion ? undefined : version
  const purl = new PackageURL(
    type,
    namespace ?? undefined,
    name,
    purlVersion ?? undefined,
    Object.keys(merged).length ? merged : undefined,
    undefined,
  )
  return purl.toString()
}

export function purlNamespaceSeparator(
  ecosystem: string,
  depname: string,
): number {
  switch (ecosystem) {
    case 'npm':
      return depname.startsWith('@') ? depname.indexOf('/') : -1
    case 'maven': {
      const colon = depname.indexOf(':')
      return colon < 0 ? depname.indexOf('/') : colon
    }
    case 'golang':
      return depname.lastIndexOf('/')
    case 'openvsx':
    case 'vscode':
    case 'composer':
      return depname.indexOf('/')
    default:
      return -1
  }
}
