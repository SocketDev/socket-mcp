import process from 'node:process'

import { defineConfig } from 'vitest/config'

import { repoTestOptions } from './vitest.shared.mts'

process.env['TZ'] ??= 'UTC'

export default defineConfig({
  test: {
    ...repoTestOptions,
    globalSetup: ['./test/e2e/fixture/build.mts'],
    include: ['test/e2e/**/*.test.mts'],
  },
})
