/**
 * @file Block top-level `await` (TLA) expressions at module scope. Fleet
 *   bundles publish to CJS (rolldown CJS output); CJS doesn't support TLA, so a
 *   module-scope `await` either fails the bundle outright or silently compiles
 *   to a Promise the consumer never awaits, leaving uninitialized exports.
 *   Allowed: `await` inside async functions / async arrows / async methods (the
 *   rule walks the parent chain to find an enclosing FunctionDeclaration /
 *   FunctionExpression / ArrowFunctionExpression). Allowed: `for await` and
 *   `await using` at non-module-scope, already inside a function. Reporting +
 *   autofix-free: rewriting TLA to an IIFE or to top-level Promise chains
 *   requires reading the surrounding intent; we report so the author makes the
 *   call.
 */

import { makeBypassChecker } from '../../lib/comment-markers.mts'
import type { AstNode, RuleContext } from '../../lib/rule-types.mts'

const FUNCTION_TYPES = new Set<string>([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
])

/**
 * Returns true when `node` has an enclosing function ancestor (any function
 * shape). Walks the `.parent` chain — relies on oxlint exposing parents on
 * visited nodes.
 */
function hasEnclosingFunction(node: AstNode): boolean {
  let current = node.parent
  while (current) {
    if (FUNCTION_TYPES.has(current.type)) {
      return true
    }
    current = current.parent
  }
  return false
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow top-level `await` at module scope. Fleet packs publish to CJS and CJS does not support top-level await.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      banned:
        'Top-level `await` at module scope — CJS bundle target does not support TLA. Wrap the await in an async function (or an async IIFE) and export the function instead of the resolved value.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    const hasBypassComment = makeBypassChecker(
      context,
      'socket/no-top-level-await',
    )
    return {
      AwaitExpression(node: AstNode) {
        if (hasEnclosingFunction(node)) {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        context.report({
          node,
          messageId: 'banned',
        })
      },
      // `for await (... of ...)` at module scope is also TLA.
      ForOfStatement(node: AstNode) {
        if (!node.await) {
          return
        }
        if (hasEnclosingFunction(node)) {
          return
        }
        if (hasBypassComment(node)) {
          return
        }
        context.report({
          node,
          messageId: 'banned',
        })
      },
    }
  },
}

// Oxlint plugin contract requires default-exported rule object.
// oxlint-disable-next-line socket/no-default-export -- oxlint plugin contract
export default rule
