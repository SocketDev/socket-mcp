import process from 'node:process'

import { defineConfig } from 'vitest/config'

import { repoTestOptions } from './vitest.shared.mts'

process.env['TZ'] ??= 'UTC'

export default defineConfig({
  test: {
    ...repoTestOptions,
    include: [
      'test/repo/unit/**/*.test.mts',
      'test/repo/integration/**/*.test.mts',
    ],
    exclude: ['test/repo/e2e/**'],
  },
})
