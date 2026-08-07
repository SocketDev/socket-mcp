/**
 * @file Per CLAUDE.md "Sorting" rule: sort the sibling properties of an object
 *   literal alphanumerically (literal byte order — ASCII before letters). Scope
 *   is deliberately narrow to avoid touching order-bearing object literals:
 *   only literals that are the initializer of a module-scope `const`, an
 *   `export const`, or an `export default` are checked. `__proto__: null` (and
 *   a bare `__proto__` shorthand) always sorts first, ahead of any data key —
 *   it's the fleet's "treat this as data, not a class" marker and must lead.
 *   The one exception to alphabetical is a rule-definition object (carries BOTH
 *   a `meta` and a `create`/`createOnce` property — the canonical ESLint/oxlint
 *   rule shape): it ENFORCES `meta` first + `create` last (the universal plugin
 *   convention) instead, since alphabetical would read backwards from every
 *   other plugin.
 *   Autofix rewrites the brace contents in sorted order, preserving single-line
 *   vs multi-line layout (mirrors `sort-named-imports`). The fix is SKIPPED
 *   (report-only) when: any property is a spread (`...rest`) — reordering
 *   across a spread changes runtime semantics; any property is computed (`[k]:
 *   v`) — the key isn't a stable sort token; or a comment lives between the
 *   first and last property — moving properties would break comment
 *   attribution. Opt out an intentionally order-bearing literal (HTTP header
 *   order, protocol field order) with a trailing or leading `// socket-lint:
 *   allow object-property-order` comment.
 */

/**
 * @type {import('eslint').Rule.RuleModule}
 */

import { isAlreadySorted, stringComparator } from '../../lib/comparators.mts'
import { hasInteriorComments } from '../../lib/comment-checks.mts'
import { makeBypassChecker } from '../../lib/comment-markers.mts'

import type { AstNode, RuleContext, RuleFixer } from '../../lib/rule-types.mts'
import { isLockstepMirror } from '../../lib/lockstep-mirror.mts'

// __proto__ markers always lead. Lower than any real key so they sort first.
const PROTO_KEY = '\u0000'

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Sort object literal properties alphanumerically (module-scope / exported literals).',
      category: 'Stylistic Issues',
      recommended: true,
    },
    fixable: 'code',
    messages: {
      ruleShape:
        'A rule-definition object keeps the canonical `{ meta, create }` order (meta first, create last), not alphabetical. Saw `{{actual}}`, expected `{{expected}}`.',
      unsorted:
        'Object properties must be sorted alphabetically. Saw `{{actual}}`, expected `{{expected}}`.',
    },
    schema: [],
  },

  create(context: RuleContext) {
    // Verbatim upstream mirrors keep upstream's shape; see lib/lockstep-mirror.mts.
    if (isLockstepMirror(context)) {
      return {}
    }
    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode
    const hasBypassComment = makeBypassChecker(
      context,
      'socket/sort-object-literal-properties',
    )

    // Sort key for a Property node. __proto__ markers sort first; everything
    // else by its static key name. Returns undefined for shapes we can't key
    // spread, computed, so the caller can skip the autofix.
    function propSortKey(prop: AstNode): string | undefined {
      if (
        prop.type === 'ExperimentalSpreadProperty' ||
        prop.type === 'SpreadElement'
      ) {
        return undefined
      }
      if (prop.computed) {
        return undefined
      }
      const key = prop.key
      if (!key) {
        return undefined
      }
      // Identifier key (`foo:` or shorthand `foo`) or string/number literal key.
      const name =
        key.name !== undefined
          ? key.name
          : key.value !== undefined
            ? String(key.value)
            : undefined
      if (name === undefined) {
        return undefined
      }
      return name === '__proto__' ? PROTO_KEY : name
    }

    // A property value that may run code when the literal is evaluated.
    // Reordering siblings would change the order those run in (module-init
    // eval order), so the autofix must NOT touch a literal that has one —
    // `{ b: sideB(), a: sideA() }` would swap the two calls.
    function hasImpureValue(prop: AstNode): boolean {
      const v = prop.value
      if (!v || typeof v.type !== 'string') {
        return false
      }
      return (
        v.type === 'AwaitExpression' ||
        v.type === 'CallExpression' ||
        v.type === 'NewExpression' ||
        v.type === 'TaggedTemplateExpression' ||
        v.type === 'YieldExpression'
      )
    }

    // A rule-definition object follows the canonical ESLint/oxlint shape: `meta`
    // first, then the `create()` / `createOnce()` visitor factory. That order is
    // the universal plugin convention every reader expects; alphabetical
    // (`create` before `meta`) would make our own rules read backwards from
    // every other plugin. So for a literal carrying BOTH a `meta` and a `create`
    // (or `createOnce`) property, this rule ENFORCES the canonical order (meta
    // first, create last) instead of alphabetical.
    // Source (tagged): https://github.com/eslint/eslint/blob/v10.5.0/docs/src/extend/custom-rules.md # v10.5.0 (2026-06-12)
    function isRuleDefinition(properties: AstNode[]): boolean {
      let hasMeta = false
      let hasCreate = false
      for (let i = 0, { length } = properties; i < length; i += 1) {
        const k = propSortKey(properties[i]!)
        if (k === 'meta') {
          hasMeta = true
        } else if (k === 'create' || k === 'createOnce') {
          hasCreate = true
        }
      }
      return hasMeta && hasCreate
    }

    // Canonical rule-definition order: `meta` first, the `create`/`createOnce`
    // factory last, any other keys keep their source order between.
    function isCreateProp(prop: AstNode): boolean {
      const k = propSortKey(prop)
      return k === 'create' || k === 'createOnce'
    }
    function ruleShapeOrder(properties: AstNode[]): AstNode[] {
      const meta = properties.filter((p: AstNode) => propSortKey(p) === 'meta')
      const create = properties.filter(isCreateProp)
      const others = properties.filter(
        (p: AstNode) => propSortKey(p) !== 'meta' && !isCreateProp(p),
      )
      return [...meta, ...others, ...create]
    }

    function checkObject(node: AstNode): void {
      const props = node.properties
      if (!props || props.length < 2) {
        return
      }
      if (hasBypassComment(node)) {
        return
      }

      const keys = props.map(propSortKey)
      // Any unkeyable property (spread / computed) → don't touch this literal.
      if (keys.some((k: string | undefined) => k === undefined)) {
        return
      }
      const safeKeys = keys as string[]

      // A rule-definition object enforces the canonical ESLint shape (meta
      // first, create last); every other literal sorts alphabetically.
      const ruleShape = isRuleDefinition(props)
      if (!ruleShape && isAlreadySorted(safeKeys)) {
        return
      }

      // If any value can run code, sorting could reorder side effects — report
      // without an autofix so a human reorders, or confirms purity, manually.
      const hasSideEffectValue = props.some(hasImpureValue)

      const sorted = ruleShape
        ? ruleShapeOrder(props)
        : [...props].toSorted((a: AstNode, b: AstNode) =>
            stringComparator(propSortKey(a)!, propSortKey(b)!),
          )

      // Already in the desired order, the rule shape, or alphabetical? The
      // non-rule case also returned above via isAlreadySorted; this covers the
      // rule-shape path, meta already first, create already last.
      if (sorted.every((p: AstNode, i: number) => p === props[i])) {
        return
      }

      const messageId = ruleShape ? 'ruleShape' : 'unsorted'

      // Display keys use the real name (PROTO_KEY is internal-only).
      const displayKey = (prop: AstNode): string => {
        const k = prop.key
        return k?.name !== undefined ? k.name : String(k?.value)
      }
      const actual = props.map(displayKey).join(', ')
      const expected = sorted.map(displayKey).join(', ')

      const first = props[0]
      const last = props[props.length - 1]

      if (
        hasSideEffectValue ||
        hasInteriorComments(sourceCode, node, first, last)
      ) {
        context.report({
          node,
          messageId: 'unsorted',
          data: { actual, expected },
        })
        return
      }

      context.report({
        node,
        messageId,
        data: { actual, expected },
        fix(fixer: RuleFixer) {
          const openBrace = sourceCode.getTokenBefore(first, {
            filter: (t: AstNode) => t.value === '{',
          })
          const closeBrace = sourceCode.getTokenAfter(last, {
            filter: (t: AstNode) => t.value === '}',
          })
          if (!openBrace || !closeBrace) {
            return undefined
          }
          const sliceStart = openBrace.range[1]
          const sliceEnd = closeBrace.range[0]
          const original = sourceCode.text.slice(sliceStart, sliceEnd)
          const isMultiline = /\n/.test(original)

          const propTexts = sorted.map((p: AstNode) => sourceCode.getText(p))
          let rebuilt
          if (isMultiline) {
            let indent = ''
            const m = original.match(/\n(?<indent>[ \t]*)/)
            /* c8 ignore start - m is always non-null when isMultiline is true (original always contains \n); groups.indent is always a string from a named capture */
            if (m) {
              indent = m.groups?.indent ?? ''
            }
            /* c8 ignore stop */
            const trailingComma = /,\s*$/.test(original.replace(/\s+$/, ''))
              ? ','
              : ''
            // Strips one level of indentation (2-space, 4-space, or tab) from the closing-brace line.
            const closeIndent = indent.replace(/^(?: {2}| {4}|\t)/, '')
            rebuilt =
              '\n' +
              propTexts.map((t: string) => indent + t).join(',\n') +
              trailingComma +
              '\n' +
              closeIndent
          } else {
            rebuilt = ' ' + propTexts.join(', ') + ' '
          }
          return fixer.replaceTextRange([sliceStart, sliceEnd], rebuilt)
        },
      })
    }

    // Only check literals that are the initializer of a module-scope const,
    // an `export const`, or an `export default`. Walk up from the
    // ObjectExpression to confirm the enclosing context.
    function isInScope(node: AstNode): boolean {
      const parent = node.parent
      if (!parent) {
        return false
      }
      // `export default { ... }`
      if (parent.type === 'ExportDefaultDeclaration') {
        return true
      }
      // `const x = { ... }` / `export const x = { ... }` at module scope.
      if (parent.type === 'VariableDeclarator' && parent.init === node) {
        const decl = parent.parent
        const declParent = decl?.parent
        if (
          decl?.type === 'VariableDeclaration' &&
          (declParent?.type === 'Program' ||
            declParent?.type === 'ExportNamedDeclaration')
        ) {
          return true
        }
      }
      return false
    }

    return {
      ObjectExpression(node: AstNode) {
        if (isInScope(node)) {
          checkObject(node)
        }
      },
    }
  },
}

// Oxlint plugin contract requires default-exported rule object.
// oxlint-disable-next-line socket/no-default-export -- oxlint plugin contract
export default rule
