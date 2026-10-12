export type ToolOutcome = 'success' | 'failure' | 'denied' | 'invalid'

export interface ToolResultOutcomeInput {
  content?: readonly unknown[] | undefined
  isError?: boolean | undefined
}

export class UpstreamHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'UpstreamHttpError'
    this.status = status
  }
}

const exceptionalOutcomes = new WeakMap<object, 'denied' | 'invalid'>()

export function classifyToolOutcome(
  result: ToolResultOutcomeInput,
): ToolOutcome {
  const outcome = exceptionalOutcomes.get(result)
  if (outcome !== undefined) {
    return outcome
  }
  return result.isError === true ? 'failure' : 'success'
}

export function classifyUpstreamHttpError(
  error: unknown,
): 'denied' | 'failure' {
  return error instanceof UpstreamHttpError &&
    (error.status === 401 || error.status === 403)
    ? 'denied'
    : 'failure'
}

export function markToolOutcome<Result extends object>(
  result: Result,
  outcome: 'denied' | 'invalid',
): Result {
  exceptionalOutcomes.set(result, outcome)
  return result
}

export function markUpstreamHttpOutcome<Result extends object>(
  result: Result,
  error: unknown,
): Result {
  if (classifyUpstreamHttpError(error) === 'denied') {
    return markToolOutcome(result, 'denied')
  }
  return result
}
