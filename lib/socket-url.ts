const SOCKET_REPORT_BASE = 'https://socket.dev'

// Build the Socket.dev report URL for a package so users can click through
// for deeper analysis when a score raises concerns. Accepts the raw artifact
// object from the Socket API (loosely typed) and maps it to the public
// /<ecosystem>/package/<path> route, honoring namespace conventions per
// ecosystem (npm scopes use `@ns/name`, golang/maven/composer use `ns/name`).
export function buildSocketReportUrl(data: unknown): string {
  const obj =
    data && typeof data === 'object'
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by the typeof-object check above; Record<string, unknown> is the loosest object view and each field is type-guarded below.
        (data as Record<string, unknown>)
      : Object.create(null)
  const { name, namespace, type } = obj
  const ecosystem = (typeof type === 'string' ? type : 'npm').toLowerCase()
  const pkgName = typeof name === 'string' ? name : 'unknown'
  const ns = typeof namespace === 'string' ? namespace : undefined

  let packagePath: string
  switch (ecosystem) {
    case 'npm':
      packagePath = ns ? `@${ns}/${pkgName}` : pkgName
      break
    case 'pypi':
    case 'gem':
    case 'nuget':
    case 'cargo':
      packagePath = pkgName
      break
    default:
      packagePath = ns ? `${ns}/${pkgName}` : pkgName
  }

  return `${SOCKET_REPORT_BASE}/${ecosystem}/package/${packagePath}`
}
