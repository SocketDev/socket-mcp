/**
 * @file Guarded compile-time define for rolldown builds. A `transform` plugin
 *   that replaces global / property-accessor reads with constant values — like
 *   oxc's `transform.define`, but it ONLY rewrites read positions. Matches that
 *   sit in an assignment target, a `delete` / `++` / `--` operand, or a binding
 *   position are left untouched. Why this exists: oxc's `define` (and
 *   `@rollup/plugin-replace`, even with `preventAssignment`) substitutes
 *   `delete` operands, so `delete process.env.DEBUG` (debug's node.js `save()`)
 *   becomes `delete undefined` — a strict-mode SyntaxError. esbuild's `define`
 *   skipped both lvalue and delete positions; this restores that behavior so
 *   risky keys (`process.env.DEBUG`, …) stay safe to define. Uses rolldown's
 *   bundled oxc parser (`rolldown/parseAst`) for reliable AST spans +
 *   `magic-string` for surgical rewrites. Keys are matched as exact
 *   `process.env.X` member chains or bare identifiers; values are
 *   already-quoted source text (same contract as esbuild / oxc `define`).
 */

import MagicString from 'magic-string'
import { parseAst } from 'rolldown/parseAst'

import type { Plugin } from 'rolldown'

interface DefineEntry {
  // Dotted chain split into segments, e.g. ['process', 'env', 'DEBUG'] or
  // ['__DEV__'] for a bare identifier.
  segments: string[]
  value: string
}

function toEntries(define: Record<string, string>): DefineEntry[] {
  return Object.entries(define).map(([key, value]) => ({
    segments: key.split('.'),
    value,
  }))
}

// A match is a read unless its immediate parent uses it as a write/delete/
// binding target. parent.type + the key under which the node hangs identify
// the position unambiguously.
function isReadPosition(parentType: string, parentKey: string): boolean {
  // `x = …` / `x += …` — left side is a write target.
  if (parentType === 'AssignmentExpression' && parentKey === 'left') {
    return false
  }
  // `delete x` / `x++` / `--x` — operand is mutated, not read.
  if (
    (parentType === 'UnaryExpression' || parentType === 'UpdateExpression') &&
    parentKey === 'argument'
  ) {
    return false
  }
  // `{ x } = …` style binding / property shorthand targets.
  if (parentType === 'AssignmentTargetPropertyIdentifier') {
    return false
  }
  return true
}

/**
 * Match a member-expression / identifier node against a define entry's
 * segments. Returns true when the node's printed chain equals the key exactly.
 * The chain is read right-to-left off nested StaticMemberExpression nodes.
 */
function matchesChain(
  node: Record<string, unknown>,
  segments: string[],
  source: string,
): boolean {
  if (segments.length === 1) {
    return node['type'] === 'Identifier' && node['name'] === segments[0]
  }
  // Multi-segment: must be a member chain whose printed text equals the key.
  const start = node['start'] as number
  const end = node['end'] as number
  return source.slice(start, end) === segments.join('.')
}

/**
 * Build a guarded-define rolldown plugin. `define` maps a key (bare identifier
 * or dotted property accessor) to already-quoted replacement source text.
 */
export function defineGuardedPlugin(define: Record<string, string>): Plugin {
  const entries = toEntries(define)
  // Top-level segment set lets us cheaply skip files that can't contain any
  // key before doing the full parse + walk.
  const firstSegments = new Set(entries.map(e => e.segments[0]!))

  return {
    name: 'define-guarded',
    transform(code) {
      // Cheap bail: no key's leading segment appears in the source.
      let maybe = false
      for (const seg of firstSegments) {
        if (code.includes(seg)) {
          maybe = true
          break
        }
      }
      if (!maybe) {
        return undefined
      }

      let program: Record<string, unknown>
      try {
        program = parseAst(code) as unknown as Record<string, unknown>
      } catch {
        // Unparseable (e.g. a syntax oxc rejects) — leave the module to the
        // main pipeline, which will surface the real error.
        return undefined
      }

      const ms = new MagicString(code)
      let rewrote = false
      // Track [start,end] spans already rewritten so a parent member chain
      // and its `.object` sub-chain don't double-overwrite.
      const done = new Set<string>()

      const walk = (
        node: unknown,
        parent: Record<string, unknown> | undefined,
        key: string | undefined,
      ): void => {
        if (!node || typeof node !== 'object') {
          return
        }
        if (Array.isArray(node)) {
          for (const child of node) {
            walk(child, parent, key)
          }
          return
        }
        const n = node as Record<string, unknown>
        if (typeof n['type'] === 'string') {
          for (const entry of entries) {
            if (!matchesChain(n, entry.segments, code)) {
              continue
            }
            const start = n['start'] as number
            const end = n['end'] as number
            const spanKey = `${start}:${end}`
            if (done.has(spanKey)) {
              continue
            }
            if (!isReadPosition(parent?.['type'] as string, key ?? '')) {
              // Mark as done so we don't reconsider the same span; a guarded
              // write target stays verbatim.
              done.add(spanKey)
              continue
            }
            ms.overwrite(start, end, entry.value)
            done.add(spanKey)
            rewrote = true
            // Don't descend into a matched chain (its `.object` is part of
            // the same replaced text).
            return
          }
        }
        for (const k of Object.keys(n)) {
          if (k === 'start' || k === 'end') {
            continue
          }
          walk(n[k], n, k)
        }
      }

      walk(program, undefined, undefined)

      if (!rewrote) {
        return undefined
      }
      return { code: ms.toString(), map: ms.generateMap({ hires: true }) }
    },
  }
}
