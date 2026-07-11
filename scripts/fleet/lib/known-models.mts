/**
 * @file The canonical set of model ids the fleet recognizes — the ONE source
 *   every model-validating gate derives from, so a model-generation bump is a
 *   single edit in socket-lib's AI_TIER (not a literal hand-copied into each
 *   check that then drifts). Combines the priced models in the canonical
 *   pricing registry (scripts/fleet/constants/model-pricing.json, all
 *   providers) with the AI_TIER tier models as a fallback when the registry is
 *   unreadable. Also exposes the floor (cheapest tier) model + effort, the tier
 *   model ids, and the tier aliases, so ai-spawns-have-paired-effort,
 *   mutating-skills-have-model, and gh-aw-workflow-models-are-canonical all
 *   share ONE definition instead of re-deriving it per check.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { AI_TIER } from '@socketsecurity/lib-stable/ai/tier'

import { REPO_ROOT } from '../paths.mts'

// The floor a programmatic spawn defaults to: the cheapest tier's model +
// effort, sourced from the canonical AI_TIER (`haiku` is the floor row) so a
// model-generation bump is one edit in socket-lib, not a hand-copied literal.
export const FLOOR_MODEL = AI_TIER.haiku.model
export const FLOOR_EFFORT = AI_TIER.haiku.effort

// The AI_TIER tier keys (fable / haiku / opus / sonnet) — valid as a bare alias
// in a harness `model:` field, which resolves the alias to the current tier
// model. A gate that accepts frontmatter (skill / workflow) unions these.
export const TIER_ALIASES: ReadonlySet<string> = new Set(Object.keys(AI_TIER))

// The tier model ids (claude-haiku-4-5, …) — always canonical, and the fallback
// membership set when the pricing registry can't be read.
export const TIER_MODELS: ReadonlySet<string> = new Set(
  Object.values(AI_TIER).map(tier => tier.model),
)

// Every model string the fleet recognizes: the priced models in the canonical
// registry (all providers) plus the AI_TIER model ids as a fallback when the
// registry is unreadable. A literal `model` outside this set is drift (a
// stale/renamed id like `claude-sonnet-4-5`) or a typo — not a model any spawn
// or workflow should pin. Bare aliases (`sonnet`/`haiku`/…) are deliberately
// EXCLUDED here — a raw CLI `--model` value must be a full id — so a caller that
// ALSO accepts aliases (skill frontmatter) unions TIER_ALIASES itself.
export function loadKnownModels(): ReadonlySet<string> {
  const models = new Set<string>(TIER_MODELS)
  const pricingPath = path.join(
    REPO_ROOT,
    'scripts/fleet/constants/model-pricing.json',
  )
  if (existsSync(pricingPath)) {
    try {
      const pricing = JSON.parse(readFileSync(pricingPath, 'utf8')) as {
        services?: Record<string, { models?: Record<string, unknown> }>
      }
      for (const svc of Object.values(pricing.services ?? {})) {
        for (const id of Object.keys(svc.models ?? {})) {
          models.add(id)
        }
      }
    } catch {
      // Registry unreadable — fall back to the AI_TIER model set; the
      // known-model check stays sound for the canonical tiers.
    }
  }
  return models
}

export const KNOWN_MODELS: ReadonlySet<string> = loadKnownModels()
