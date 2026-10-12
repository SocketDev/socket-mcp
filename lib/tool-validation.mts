import { TypeCompiler } from '@sinclair/typebox/compiler'
import { ValueErrorType } from '@sinclair/typebox/errors'
import type { TSchema } from '@sinclair/typebox'

import type {
  ToolInputSchema,
  ToolInputValidator,
  ToolValidationIssue,
  ToolValidationResult,
} from './tool-types.mts'

const MAX_VALIDATION_ISSUES = 5
const MAX_VALIDATION_PATH_LENGTH = 80

export interface ToolSchemaDefinition {
  readonly inputSchema: ToolInputSchema
  readonly validateInput: ToolInputValidator
}

export function defineToolSchema(
  schema: TSchema & { type: 'object' },
): ToolSchemaDefinition {
  const validator = TypeCompiler.Compile(schema)
  return Object.setPrototypeOf(
    {
      inputSchema: schema,
      validateInput(value: unknown) {
        if (validator.Check(value)) {
          return Object.setPrototypeOf({ valid: true }, null)
        }
        const issues: ToolValidationIssue[] = []
        for (const error of validator.Errors(value)) {
          if (issues.length >= MAX_VALIDATION_ISSUES) {
            break
          }
          issues.push(
            Object.setPrototypeOf(
              {
                path: formatValidationPath(error.path),
                reason: formatValidationReason(error.type),
              },
              null,
            ),
          )
        }
        return Object.setPrototypeOf({ valid: false, issues }, null)
      },
    },
    null,
  )
}

export function formatToolValidationFailure(
  result: Extract<ToolValidationResult, { valid: false }>,
): string {
  const fields = result.issues.map(issue => `${issue.path} (${issue.reason})`)
  return `Invalid tool arguments. Validation failed at: ${fields.join(', ')}`
}

export function formatValidationPath(path: string): string {
  const safePath = path
    .replace(/[\u0000-\u001f\u007f]/gu, '?')
    .slice(0, MAX_VALIDATION_PATH_LENGTH)
  return safePath || '/'
}

export function formatValidationReason(type: ValueErrorType): string {
  switch (type) {
    case ValueErrorType.ObjectAdditionalProperties:
      return 'unknown field'
    case ValueErrorType.ObjectRequiredProperty:
      return 'required field'
    default:
      return 'schema constraint'
  }
}
