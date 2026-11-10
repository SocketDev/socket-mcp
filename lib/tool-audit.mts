import crypto from 'node:crypto'

export function tokenIdentity(token: string | undefined): string {
  if (!token) {
    return 'operator'
  }
  return (
    'sha256:' +
    crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
  )
}
