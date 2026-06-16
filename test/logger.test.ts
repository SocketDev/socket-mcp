import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// `debug()` reads SOCKET_DEBUG at module-import time, so each case imports a
// fresh module copy with the env configured up front.
let savedDebug: string | undefined

beforeEach(() => {
  savedDebug = process.env['SOCKET_DEBUG']
  vi.resetModules()
})

afterEach(() => {
  if (savedDebug === undefined) {
    delete process.env['SOCKET_DEBUG']
  } else {
    process.env['SOCKET_DEBUG'] = savedDebug
  }
  vi.restoreAllMocks()
})

describe('debug', () => {
  test('forwards to logger.info when SOCKET_DEBUG is set', async () => {
    process.env['SOCKET_DEBUG'] = '1'
    const mod = await import('../lib/logger.ts')
    const spy = vi
      .spyOn(mod.logger, 'info')
      .mockImplementation(() => mod.logger)
    mod.debug({ x: 1 }, 'trace')
    expect(spy).toHaveBeenCalledWith({ x: 1 }, 'trace')
  })

  test('stays silent when SOCKET_DEBUG is unset', async () => {
    delete process.env['SOCKET_DEBUG']
    const mod = await import('../lib/logger.ts')
    const spy = vi
      .spyOn(mod.logger, 'info')
      .mockImplementation(() => mod.logger)
    mod.debug('ignored')
    expect(spy).not.toHaveBeenCalled()
  })
})
