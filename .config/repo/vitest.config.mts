import process from 'node:process'

import { defineConfig } from 'vitest/config'

process.env['TZ'] ??= 'UTC'

export default defineConfig({
  test: {
    include: ['test/repo/unit/**/*.test.mts', 'test/repo/integration/**/*.test.mts'],
    exclude: ['test/repo/e2e/**'],
    isolate: true,
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
