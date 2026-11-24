import process from 'node:process'

import { defineConfig } from 'vitest/config'

import { repoTestOptions } from './vitest.shared.mts'

process.env['TZ'] ??= 'UTC'

export default defineConfig({
  test: {
    ...repoTestOptions,
    globalSetup: ['./scripts/test/e2e/build.mts'],
    include: ['test/e2e/**/*.test.mts'],
  },
})
