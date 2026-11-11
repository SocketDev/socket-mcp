import { expect, it, vi } from 'vitest'
import { waitForNpmVersion } from '../../../scripts/repo/npm/availability.mts'

it('retries 404 and 429, honoring Retry-After before succeeding', async () => {
  const statuses = [404, 429, 200]
  const delays: number[] = []
  await waitForNpmVersion('https://registry.npmjs.org/pkg/1.2.3', {
    fetcher: async () => {
      const status = statuses.shift()!
      return {
        status,
        headers: new Headers(status === 429 ? { 'retry-after': '5' } : {}),
      } as Response
    },
    wait: async ms => {
      delays.push(ms)
    },
    timeoutMs: 60_000,
  })
  expect(delays).toEqual([2000, 5000])
})

it('retries a transient network failure before availability succeeds', async () => {
  let attempts = 0
  const delays: number[] = []
  await waitForNpmVersion('https://registry.npmjs.org/pkg/1.2.3', {
    fetcher: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('connection reset')
      return { status: 200, headers: new Headers() } as Response
    },
    wait: async ms => {
      delays.push(ms)
    },
    timeoutMs: 60_000,
  })
  expect(attempts).toBe(2)
  expect(delays).toEqual([2000])
})

it('times out repeated not-found responses without real waiting', async () => {
  let now = 0
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const delays: number[] = []
  let attempts = 0
  try {
    await expect(
      waitForNpmVersion('https://registry.npmjs.org/pkg/1.2.3', {
        fetcher: async () => {
          attempts += 1
          return { status: 404, headers: new Headers() } as Response
        },
        wait: async ms => {
          delays.push(ms)
          now += ms
        },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow('Timed out')
  } finally {
    dateNow.mockRestore()
  }
  expect(attempts).toBe(2)
  expect(delays).toEqual([2000, 3000])
})

it('fails fast for registry errors unrelated to pending publication', async () => {
  await expect(
    waitForNpmVersion('https://registry.npmjs.org/pkg/1.2.3', {
      fetcher: async () =>
        ({ status: 401, headers: new Headers() }) as Response,
      wait: async () => {},
    }),
  ).rejects.toThrow('HTTP 401')
})
