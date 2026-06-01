import { describe, expect, test } from 'vitest'

import { buildPurl } from '../lib/purl.ts'

describe('buildPurl produces correct PURLs across all ecosystems', () => {
  test('npm unscoped', () => {
    expect(buildPurl('npm', 'lodash', '4.17.21')).toBe('pkg:npm/lodash@4.17.21')
    expect(buildPurl('npm', 'express', '4.18.2')).toBe('pkg:npm/express@4.18.2')
  })

  test('npm scoped - encodes @ as %40', () => {
    expect(buildPurl('npm', '@babel/core', '7.24.0')).toBe(
      'pkg:npm/%40babel/core@7.24.0',
    )
    expect(buildPurl('npm', '@types/node', '20.0.0')).toBe(
      'pkg:npm/%40types/node@20.0.0',
    )
    expect(buildPurl('npm', '@nestjs/core', '10.0.0')).toBe(
      'pkg:npm/%40nestjs/core@10.0.0',
    )
  })

  test('npm version omitted when unknown', () => {
    expect(buildPurl('npm', 'lodash', 'unknown')).toBe('pkg:npm/lodash')
    expect(buildPurl('npm', 'lodash', '1.0.0')).toBe('pkg:npm/lodash')
  })

  test('pypi', () => {
    expect(buildPurl('pypi', 'requests', '2.31.0')).toBe(
      'pkg:pypi/requests@2.31.0',
    )
    expect(buildPurl('pypi', 'flask', '2.3.2')).toBe('pkg:pypi/flask@2.3.2')
    expect(buildPurl('pypi', 'scikit-learn', '1.3.0')).toBe(
      'pkg:pypi/scikit-learn@1.3.0',
    )
  })

  test('gem', () => {
    expect(buildPurl('gem', 'rails', '7.1.0')).toBe('pkg:gem/rails@7.1.0')
    expect(buildPurl('gem', 'puma', '6.4.0')).toBe('pkg:gem/puma@6.4.0')
  })

  test('golang - namespace/name split per PURL spec', () => {
    expect(buildPurl('golang', 'github.com/gin-gonic/gin', '1.9.0')).toBe(
      'pkg:golang/github.com/gin-gonic/gin@1.9.0',
    )
    expect(buildPurl('golang', 'golang.org/x/crypto', '0.10.0')).toBe(
      'pkg:golang/golang.org/x/crypto@0.10.0',
    )
  })

  test('maven groupId:artifactId', () => {
    expect(
      buildPurl(
        'maven',
        'org.springframework.boot:spring-boot-starter-web',
        '3.1.0',
      ),
    ).toBe('pkg:maven/org.springframework.boot/spring-boot-starter-web@3.1.0')
  })

  test('maven groupId/artifactId', () => {
    expect(
      buildPurl('maven', 'org.apache.commons/commons-lang3', '3.12.0'),
    ).toBe('pkg:maven/org.apache.commons/commons-lang3@3.12.0')
  })

  test('nuget', () => {
    expect(buildPurl('nuget', 'Newtonsoft.Json', '13.0.3')).toBe(
      'pkg:nuget/Newtonsoft.Json@13.0.3',
    )
    expect(buildPurl('nuget', 'Microsoft.Extensions.Logging', '8.0.0')).toBe(
      'pkg:nuget/Microsoft.Extensions.Logging@8.0.0',
    )
  })

  test('cargo', () => {
    expect(buildPurl('cargo', 'serde', '1.0.193')).toBe(
      'pkg:cargo/serde@1.0.193',
    )
    expect(buildPurl('cargo', 'tokio', '1.30.0')).toBe('pkg:cargo/tokio@1.30.0')
  })

  test('version omitted when empty', () => {
    expect(buildPurl('npm', 'lodash', '')).toBe('pkg:npm/lodash')
  })
})
