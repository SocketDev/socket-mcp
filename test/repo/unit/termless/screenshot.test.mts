import { createTerminal } from '@termless/core'
import { createXtermBackend } from '@termless/xtermjs'
import { expect, onTestFinished, test } from 'vitest'

import manifest from '../../../../package.json' with { type: 'json' }
import {
  normalizeOutput,
  renderScreenshot,
} from '../../../lib/termless/screenshot.mts'

test('trims unused rows but keeps styled blanks and the visible cursor', () => {
  const terminal = createTerminal({
    backend: createXtermBackend(),
    cols: 20,
    rows: 30,
  })
  onTestFinished(() => terminal.close())
  terminal.feed('first\r\n\r\nlast\x1b[?25l')
  const height = () =>
    Number(renderScreenshot(terminal).match(/height="(\d+)"/u)?.[1])
  const initial = height()
  expect(initial).toBeLessThan(300)
  terminal.feed('\x1b[7;1H\x1b[44m \x1b[0m')
  const highlighted = height()
  expect(highlighted).toBeGreaterThan(initial)
  terminal.feed('\x1b[12;1H\x1b[?25h')
  expect(height()).toBeGreaterThan(highlighted)
})

test('replaces the package version and the given values', () => {
  expect(
    normalizeOutput(
      `HTTP server version ${manifest.version} started on port 4321\r\n` +
        `server version ${manifest.version} started`,
      [['4321', '<port>']],
    ),
  ).toBe(
    'HTTP server version <version> started on port <port>\r\n' +
      'server version <version> started',
  )
})
