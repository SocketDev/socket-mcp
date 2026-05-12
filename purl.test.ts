#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { buildPurl } from './lib/purl.ts'

test('buildPurl produces correct PURLs across all ecosystems', async t => {
  await t.test('npm unscoped', () => {
    assert.strictEqual(
      buildPurl('npm', 'lodash', '4.17.21'),
      'pkg:npm/lodash@4.17.21',
    )
    assert.strictEqual(
      buildPurl('npm', 'express', '4.18.2'),
      'pkg:npm/express@4.18.2',
    )
  })

  await t.test('npm scoped - encodes @ as %40', () => {
    assert.strictEqual(
      buildPurl('npm', '@babel/core', '7.24.0'),
      'pkg:npm/%40babel/core@7.24.0',
    )
    assert.strictEqual(
      buildPurl('npm', '@types/node', '20.0.0'),
      'pkg:npm/%40types/node@20.0.0',
    )
    assert.strictEqual(
      buildPurl('npm', '@nestjs/core', '10.0.0'),
      'pkg:npm/%40nestjs/core@10.0.0',
    )
  })

  await t.test('npm version omitted when unknown', () => {
    assert.strictEqual(buildPurl('npm', 'lodash', 'unknown'), 'pkg:npm/lodash')
    assert.strictEqual(buildPurl('npm', 'lodash', '1.0.0'), 'pkg:npm/lodash')
  })

  await t.test('pypi', () => {
    assert.strictEqual(
      buildPurl('pypi', 'requests', '2.31.0'),
      'pkg:pypi/requests@2.31.0',
    )
    assert.strictEqual(
      buildPurl('pypi', 'flask', '2.3.2'),
      'pkg:pypi/flask@2.3.2',
    )
    assert.strictEqual(
      buildPurl('pypi', 'scikit-learn', '1.3.0'),
      'pkg:pypi/scikit-learn@1.3.0',
    )
  })

  await t.test('gem', () => {
    assert.strictEqual(
      buildPurl('gem', 'rails', '7.1.0'),
      'pkg:gem/rails@7.1.0',
    )
    assert.strictEqual(buildPurl('gem', 'puma', '6.4.0'), 'pkg:gem/puma@6.4.0')
  })

  await t.test('golang - namespace/name split per PURL spec', () => {
    assert.strictEqual(
      buildPurl('golang', 'github.com/gin-gonic/gin', '1.9.0'),
      'pkg:golang/github.com/gin-gonic/gin@1.9.0',
    )
    assert.strictEqual(
      buildPurl('golang', 'golang.org/x/crypto', '0.10.0'),
      'pkg:golang/golang.org/x/crypto@0.10.0',
    )
  })

  await t.test('maven groupId:artifactId', () => {
    assert.strictEqual(
      buildPurl(
        'maven',
        'org.springframework.boot:spring-boot-starter-web',
        '3.1.0',
      ),
      'pkg:maven/org.springframework.boot/spring-boot-starter-web@3.1.0',
    )
  })

  await t.test('maven groupId/artifactId', () => {
    assert.strictEqual(
      buildPurl('maven', 'org.apache.commons/commons-lang3', '3.12.0'),
      'pkg:maven/org.apache.commons/commons-lang3@3.12.0',
    )
  })

  await t.test('nuget', () => {
    assert.strictEqual(
      buildPurl('nuget', 'Newtonsoft.Json', '13.0.3'),
      'pkg:nuget/Newtonsoft.Json@13.0.3',
    )
    assert.strictEqual(
      buildPurl('nuget', 'Microsoft.Extensions.Logging', '8.0.0'),
      'pkg:nuget/Microsoft.Extensions.Logging@8.0.0',
    )
  })

  await t.test('cargo', () => {
    assert.strictEqual(
      buildPurl('cargo', 'serde', '1.0.193'),
      'pkg:cargo/serde@1.0.193',
    )
    assert.strictEqual(
      buildPurl('cargo', 'tokio', '1.30.0'),
      'pkg:cargo/tokio@1.30.0',
    )
  })

  await t.test('version omitted when empty', () => {
    assert.strictEqual(buildPurl('npm', 'lodash', ''), 'pkg:npm/lodash')
  })
})
