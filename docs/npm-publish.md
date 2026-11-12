# Publish to npm

Run `pnpm run publish:npm` from the repository. The first run creates a signed release preparation commit and opens a pull request with the package version, extension manifest, README asset pins, and changelog update. Review and merge that PR through the normal required checks. Run `pnpm run publish:npm` again to reserve its version tag, build and validate the package, and stage it with npm provenance.

The changelog starts from the last published version on the configured release track. Before that track has a published version, it uses the latest published stable version. If the package has no published release, it includes all history. The baseline comes from its version tag or npm `gitHead`; if neither is available, the workflow finds the first parent commit that changed `package.json` to that version and verifies it is an ancestor. A `feat:` or `feat(scope):` commit selects a minor bump; otherwise the default is a patch bump. Stable releases strip a committed prerelease hint. Published versions and reserved tags are never reused.

An explicit release config is required at `.config/release.json`, `release.json`, or `.release.json`. Missing, invalid, or conflicting configs stop release preparation. The current `stable-from-hint` mode keeps the normal stable release flow. A `prerelease-only` track declares a stable `versionHint`, a prerelease `identifier`, and its matching npm `distTag`; each preparation advances only the numeric prerelease suffix. Validation rejects stable versions and mismatched tags, and GitHub marks the resulting release as a prerelease. For example:

```json
{
  "mode": "prerelease-only",
  "versionHint": "2.1.0",
  "identifier": "rc",
  "distTag": "prerelease-2.1.0"
}
```

The resume run must target the exact default branch commit created by the preparation PR. If the branch advances before that run, the workflow creates a new preparation PR from the newer source commit.

The workflow packs the package once, validates the archive, and uploads the same bytes to npm staging with OIDC provenance. The Actions log and summary show package, version, tag, and stage ID. After reviewing the staged package in npm, approve it from a local checkout with:

```sh
pnpm run approve:npm <stage-id>
```

Approval waits for npm validation, approves the exact stage, then dispatches GitHub release finalization. If npm already reports the stage as `published`, rerunning `approve:npm <stage-id>` skips approval and retries GitHub finalization. A failed or timed-out GitHub availability check can also be retried from Actions with the same tag; do not stage the package again.

If npm reports `blocked` or `deleted`, that version is burned: no GitHub release is created and its tag stays reserved. After confirming the stage cannot be approved, run `pnpm run publish:npm` to prepare the next version. The changelog starts at the last successful publication, so changes from burned attempts carry forward. The same command prepares the next version if validation fails after a tag is reserved but before a stage ID is created. Do not rerun it while a stage is still `validating` or `staged`; resume that stage by its ID instead. If the ID is missing from the run output, recover it from the workflow log or npm before starting another version. Never delete or reassign a reserved tag.
