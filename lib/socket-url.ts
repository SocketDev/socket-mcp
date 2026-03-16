const SOCKET_REPORT_BASE = 'https://socket.dev'

/**
 * Build the Socket.dev report URL for a package so users can click through
 * for deeper analysis when a score raises concerns.
 */
export function buildSocketReportUrl (data: unknown): string {
  const obj = data && typeof data === 'object' ? data as Record<string, unknown> : Object.create(null)
  const type = obj.type
  const name = obj.name
  const namespace = obj.namespace
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
    case 'golang':
    case 'maven':
    case 'composer':
      packagePath = ns ? `${ns}/${pkgName}` : pkgName
      break
    default:
      packagePath = ns ? `${ns}/${pkgName}` : pkgName
  }

  return `${SOCKET_REPORT_BASE}/${ecosystem}/package/${packagePath}`
}
