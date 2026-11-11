import { isMainModule, runMain } from '../cli.mts'

// npm lifecycle state | meaning | action
// validating | npm is still checking the stage | poll
// staged | ready for maintainer approval | approve locally with 2FA
// published | live and installable | finalize the GitHub release
// blocked | automated validation failed | stop without a GitHub release
// deleted | published, then removed | stop and never reuse the version

export async function waitForNpmVersion(
  url: string,
  options: {
    fetcher?: typeof fetch
    wait?: (ms: number) => Promise<void>
    timeoutMs?: number
  } = {},
): Promise<void> {
  const fetcher = options.fetcher ?? fetch
  const wait =
    options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000)
  let delay = 2_000
  while (true) {
    const remaining = deadline - Date.now()
    if (remaining <= 0)
      throw new Error(
        'Timed out waiting for npm version availability; rerun this workflow to retry.',
      )
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      })
    } catch {
      if (Date.now() >= deadline)
        throw new Error(
          'Timed out waiting for npm version availability; rerun this workflow to retry.',
        )
      await wait(Math.min(delay, deadline - Date.now()))
      delay = Math.min(delay * 2, 60_000)
      continue
    }
    if (response.status === 200) return
    if (
      response.status !== 404 &&
      response.status !== 429 &&
      (response.status < 500 || response.status > 599)
    )
      throw new Error(
        `npm registry availability check returned HTTP ${response.status}.`,
      )
    if (Date.now() >= deadline)
      throw new Error(
        'Timed out waiting for npm version availability; rerun this workflow to retry.',
      )
    const retryAfter = response.headers.get('retry-after')
    const retrySeconds = Number(retryAfter)
    const retryDate = retryAfter ? Date.parse(retryAfter) : Number.NaN
    const retryMs =
      Number.isFinite(retrySeconds) && retrySeconds > 0
        ? retrySeconds * 1000
        : Number.isFinite(retryDate)
          ? Math.max(0, retryDate - Date.now())
          : delay
    await wait(Math.min(retryMs, deadline - Date.now()))
    delay = Math.min(delay * 2, 60_000)
  }
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const version = args[0]
  if (
    args.length !== 1 ||
    !version ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(
      version,
    )
  )
    throw new Error('Usage: node scripts/repo/npm/availability.mts <version>')
  await waitForNpmVersion(
    `https://registry.npmjs.org/@socketsecurity%2fmcp/${encodeURIComponent(version)}`,
  )
}

if (isMainModule(import.meta.url))
  runMain(main, {
    describe:
      'Waits for the exact npm version to become anonymously available.',
    help: 'Usage: node scripts/repo/npm/availability.mts <version>',
  })
