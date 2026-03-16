#!/usr/bin/env node
import { test } from 'node:test'
import assert from 'node:assert'
import { buildSocketReportUrl } from './socket-url.ts'

test('buildSocketReportUrl produces correct URLs across ecosystems', async (t) => {
  await t.test('npm unscoped', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'npm', name: 'express' }),
      'https://socket.dev/npm/package/express'
    )
  })

  await t.test('npm scoped', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'npm', namespace: 'babel', name: 'core' }),
      'https://socket.dev/npm/package/@babel/core'
    )
  })

  await t.test('pypi', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'pypi', name: 'requests' }),
      'https://socket.dev/pypi/package/requests'
    )
  })

  await t.test('golang', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'golang', namespace: 'github.com/gin-gonic', name: 'gin' }),
      'https://socket.dev/golang/package/github.com/gin-gonic/gin'
    )
  })

  await t.test('maven', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'maven', namespace: 'org.apache.commons', name: 'commons-lang3' }),
      'https://socket.dev/maven/package/org.apache.commons/commons-lang3'
    )
  })

  await t.test('cargo', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'cargo', name: 'serde' }),
      'https://socket.dev/cargo/package/serde'
    )
  })

  await t.test('gem', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'gem', name: 'rails' }),
      'https://socket.dev/gem/package/rails'
    )
  })

  await t.test('nuget', () => {
    assert.strictEqual(
      buildSocketReportUrl({ type: 'nuget', name: 'Newtonsoft.Json' }),
      'https://socket.dev/nuget/package/Newtonsoft.Json'
    )
  })

  await t.test('handles unknown/missing data gracefully', () => {
    assert.strictEqual(
      buildSocketReportUrl({}),
      'https://socket.dev/npm/package/unknown'
    )
    assert.strictEqual(
      buildSocketReportUrl(null),
      'https://socket.dev/npm/package/unknown'
    )
  })
})
