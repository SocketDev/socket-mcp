/*
 * @file Per CLAUDE.md "Function declarations": 🚨 No boolean-trap params; use
 *   an options object. A boolean positional forces callers to write `foo(x,
 *   true)` where the `true` carries no meaning at the call site — pass `foo(x,
 *   { verbose: true })` instead. The edit-time `no-boolean-trap-guard` hook
 *   catches NEW signatures as they're written; this lint rule is the CI /
 *   back-catalog scan that flags existing offenders across the tree. Flags a
 *   function (declaration / expression / arrow / method) with ≥2 params where
 *   at least one param is typed `boolean` (incl. `boolean | undefined`,
 *   optional `flag?: boolean`). Reporting only — the fix (collapse the booleans
 *   into an options object) changes the call sites, so it can't be
 *   auto-applied. Skipped:
 *
 *   - A single boolean param alone — a pure predicate (`isValid(v: boolean)`).
 *   - Overload signatures (no function body — type-only contracts).
 *   - Bypass: a `oxlint-disable-next-line socket/no-boolean-trap-param` comment on the function.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import type { AstNode, RuleContext } from '../../lib/rule-types.mts'

// Is a param's type annotation `boolean`, or a union that includes `boolean`
// (e.g. `boolean | undefined`)? Handles the optional `flag?: boolean` form too
// (the `?` lives on the param, the annotation is still TSBooleanKeyword).
function isBooleanTyped(param: AstNode): boolean {
  const ann = param?.typeAnnotation?.typeAnnotation
  if (!ann) {
    return false
  }
  if (ann.type === 'TSBooleanKeyword') {
    return true
  }
  if (ann.type === 'TSUnionType' && Array.isArray(ann.types)) {
    return ann.types.some((t: AstNode) => t?.type === 'TSBooleanKeyword')
  }
  return false
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'No boolean-trap params — a boolean positional in a 2+-param signature should be an options object. Per CLAUDE.md "Function declarations".',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      banned:
        'boolean positional param `{{name}}` — callers write `foo(x, true)` where the flag is meaningless at the call site. Use an options object: `foo(x, { {{name}}: true })`. Bypass: add a `oxlint-disable-next-line socket/no-boolean-trap-param` comment.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    const hasBypassComment = makeBypassChecker(
      context,
      'socket/no-boolean-trap-param',
    )

    function check(node: AstNode): void {
      // Overload / type-only signatures have no body — skip.
      if (node.body == null) {
        return
      }
      const params = node.params
      if (!Array.isArray(params) || params.length < 2) {
        return
      }
      if (hasBypassComment(node)) {
        return
      }
      for (let i = 0, { length } = params; i < length; i += 1) {
        const p = params[i]!
        if (isBooleanTyped(p)) {
          const name = p.type === 'Identifier' ? p.name : 'flag'
          context.report({ node: p, messageId: 'banned', data: { name } })
        }
      }
    }

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    }
  },
}

// Oxlint plugin contract requires default-exported rule object.
// oxlint-disable-next-line socket/no-default-export -- oxlint plugin contract
export default rule
