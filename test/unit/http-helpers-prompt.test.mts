/**
 * @file `getApiKeyInteractively` drives a readline prompt on the real stdin,
 *   so `node:readline` is mocked to answer it. Lives in its own file because
 *   the mock is module-wide.
 */

import process from 'node:process'
import type { Interface } from 'node:readline'

import { afterEach, expect, test, vi } from 'vitest'

import { getApiKeyInteractively } from '../../lib/http-helpers.ts'

const { closed, prompts, scriptedAnswer } = vi.hoisted(() => ({
  closed: { count: 0 },
  prompts: [] as string[],
  scriptedAnswer: { value: '' },
}))

vi.mock(import('node:readline'), async importOriginal => {
  const actual = await importOriginal()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double / fixture cast: the mock provides only the members the code under test touches.
  const stubInterface = {
    close() {
      closed.count += 1
    },
    question(prompt: string, callback: (answer: string) => void) {
      prompts.push(prompt)
      callback(scriptedAnswer.value)
    },
  } as unknown as Interface
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- createInterface is overloaded; the single-shape stub is retyped to the original signature.
  const createInterface = (() =>
    stubInterface) as unknown as typeof actual.createInterface
  return {
    ...actual,
    default: { ...actual, createInterface },
    createInterface,
  }
})

afterEach(() => {
  closed.count = 0
  prompts.length = 0
  scriptedAnswer.value = ''
  vi.restoreAllMocks()
})

test('getApiKeyInteractively returns the answer and closes the prompt', async () => {
  scriptedAnswer.value = 'sktsec_typed_by_hand'
  expect(await getApiKeyInteractively()).toBe('sktsec_typed_by_hand')
  expect(prompts).toEqual(['Please enter your Socket API key: '])
  // The readline interface owns stdin; leaving it open would hang the process.
  expect(closed.count).toBe(1)
})

test('getApiKeyInteractively exits when the operator enters nothing', async () => {
  // Standing in for the real `process.exit(1)`, which never returns either.
  const exited = new Error('process exited')
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw exited
  })
  scriptedAnswer.value = ''
  await expect(getApiKeyInteractively()).rejects.toBe(exited)
  expect(exit).toHaveBeenCalledWith(1)
})
