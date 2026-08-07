#!/usr/bin/env node
/*
 * @file `check --all` gate: a repo whose workflows provision the on-device
 *   model has actually OPTED IN to it, so those AI legs run instead of
 *   silently no-opping.
 *
 *   The odai path is fail-open by design, and every layer of it is quiet. The
 *   `setup-odai` action reports `ready=false` rather than failing; consumers
 *   exit 69, which reads as a clean skip; and `localAssistEnabled` returns
 *   false for an absent config, an absent `ai` block, or an absent field. Each
 *   of those is right on its own — no repo should gain an AI call it never
 *   asked for. Stacked, they mean a workflow can provision a ~4 GB model,
 *   invoke it, and produce nothing, with a green run and no diagnostic
 *   anywhere.
 *
 *   That is not hypothetical: the fleet built weekly-update's decision legs
 *   and get-green's failure digest on odai, pinned the CLI, cached the model,
 *   and wrote the fail-open contract — while `ai.localAssist` was undefined in
 *   every single repo. The whole capability was dead on arrival, and nothing
 *   said so, because "switched off" and "working fine" look identical from
 *   outside.
 *
 *   So the rule is narrow: if a workflow references the setup-odai action, the
 *   repo must set `ai.localAssist: true`. Provisioning is the declaration of
 *   intent; the opt-in has to match it. The reverse is NOT checked — a repo
 *   may opt in for local-only consumers (land-work's commit-subject assist)
 *   with no CI leg at all.
 *
 *   Exit: 0 — no odai workflow, or opted in; 1 — provisioned but switched off.
 *
 *   Usage: node scripts/fleet/check/odai-legs-are-switched-on.mts [--quiet]
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getDefaultLogger } from '@socketsecurity/lib-stable/logger/default'

import { REPO_ROOT } from '../paths.mts'
import { isMainModule } from '../_shared/is-main-module.mts'
import { localAssistEnabled } from '../_shared/odai.mts'
import { runMain } from '../_shared/run-main.mts'

import type { ScriptMeta } from '../_shared/run-main.mts'

const logger = getDefaultLogger()

// The composite whose presence means "this workflow intends to use the
// on-device model".
export const SETUP_ODAI_USES = './.github/actions/fleet/setup-odai'

/**
 * The workflow filenames under `dir` that provision the on-device model.
 * Pure apart from the directory read; exported for tests.
 */
export function odaiWorkflowsIn(dir: string): string[] {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: string[] = []
  const sorted = entries.toSorted()
  for (let i = 0, { length } = sorted; i < length; i += 1) {
    const name = sorted[i]!
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) {
      continue
    }
    try {
      if (
        readFileSync(path.join(dir, name), 'utf8').includes(SETUP_ODAI_USES)
      ) {
        out.push(name)
      }
    } catch {
      // Fail-open per file — an unreadable workflow is not evidence.
    }
  }
  return out
}

export function main(): number {
  const quiet = process.argv.includes('--quiet')
  const workflows = odaiWorkflowsIn(
    path.join(REPO_ROOT, '.github', 'workflows'),
  )
  if (!workflows.length) {
    if (!quiet) {
      logger.success(
        '[odai-legs-are-switched-on] no workflow provisions the on-device model here — nothing to switch on.',
      )
    }
    return 0
  }
  if (!localAssistEnabled(REPO_ROOT)) {
    logger.fail(
      '[odai-legs-are-switched-on] the on-device model is provisioned but the repo never opted in:',
    )
    logger.error(
      `  What:   ${workflows.length} workflow(s) run the setup-odai action, but \`ai.localAssist\` is not true, so every odai consumer clean-skips (exit 69) and the AI legs produce nothing.`,
    )
    logger.error(
      '  Where:  .config/repo/socket-wheelhouse.json — the `ai.localAssist` field.',
    )
    logger.error(
      `  Saw:    provisioned by ${workflows.join(', ')}; opted in: no.`,
    )
    logger.error(
      '  Fix:    add `"ai": { "localAssist": true }` to the config — or drop the setup-odai step if the leg is not wanted. Do not leave it provisioned-and-off: the run stays green either way, which is what makes this silent.',
    )
    return 1
  }
  if (!quiet) {
    logger.success(
      `[odai-legs-are-switched-on] ${workflows.length} workflow(s) provision the on-device model and the repo opted in.`,
    )
  }
  return 0
}

const SCRIPT_META: ScriptMeta = {
  describe:
    'a repo provisioning the on-device model has opted into it, so its AI legs run',
  help: `Usage: node scripts/fleet/check/odai-legs-are-switched-on.mts`,
}

/* c8 ignore start - entry-point wiring, exercised by running the script. */
if (isMainModule(import.meta.url)) {
  runMain(main, SCRIPT_META)
}
/* c8 ignore stop */
