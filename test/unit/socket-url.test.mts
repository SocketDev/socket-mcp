import { describe, expect, test } from 'vitest'

import { buildSocketReportUrl } from '../../lib/socket-url.ts'

describe('buildSocketReportUrl produces correct URLs across ecosystems', () => {
  test('npm unscoped', () => {
    expect(buildSocketReportUrl({ type: 'npm', name: 'express' })).toBe(
      'https://socket.dev/npm/package/express',
    )
  })

  test('npm scoped', () => {
    expect(
      buildSocketReportUrl({ type: 'npm', namespace: 'babel', name: 'core' }),
    ).toBe('https://socket.dev/npm/package/@babel/core')
  })

  test('pypi', () => {
    expect(buildSocketReportUrl({ type: 'pypi', name: 'requests' })).toBe(
      'https://socket.dev/pypi/package/requests',
    )
  })

  test('golang', () => {
    expect(
      buildSocketReportUrl({
        type: 'golang',
        namespace: 'github.com/gin-gonic',
        name: 'gin',
      }),
    ).toBe('https://socket.dev/golang/package/github.com/gin-gonic/gin')
  })

  test('maven', () => {
    expect(
      buildSocketReportUrl({
        type: 'maven',
        namespace: 'org.apache.commons',
        name: 'commons-lang3',
      }),
    ).toBe('https://socket.dev/maven/package/org.apache.commons/commons-lang3')
  })

  test('cargo', () => {
    expect(buildSocketReportUrl({ type: 'cargo', name: 'serde' })).toBe(
      'https://socket.dev/cargo/package/serde',
    )
  })

  test('gem', () => {
    expect(buildSocketReportUrl({ type: 'gem', name: 'rails' })).toBe(
      'https://socket.dev/gem/package/rails',
    )
  })

  test('nuget', () => {
    expect(
      buildSocketReportUrl({ type: 'nuget', name: 'Newtonsoft.Json' }),
    ).toBe('https://socket.dev/nuget/package/Newtonsoft.Json')
  })

  test('handles unknown/missing data gracefully', () => {
    expect(buildSocketReportUrl({})).toBe(
      'https://socket.dev/npm/package/unknown',
    )
    expect(buildSocketReportUrl(undefined)).toBe(
      'https://socket.dev/npm/package/unknown',
    )
  })
})
