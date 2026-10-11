export type ToolOutcome = 'success' | 'failure' | 'denied' | 'invalid'

export interface ToolResultOutcomeInput {
  content?: readonly unknown[] | undefined
  isError?: boolean | undefined
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

export function markToolOutcome<Result extends object>(
  result: Result,
  outcome: 'denied' | 'invalid',
): Result {
  exceptionalOutcomes.set(result, outcome)
  return result
}
